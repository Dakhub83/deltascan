import type { RawData } from 'ws';
import type { Bar } from '@deltascan/shared';
import type { Logger } from '../../../lib/logger';
import { ReconnectingSocket } from '../../ReconnectingSocket';
import { MarketDataProvider } from '../MarketDataProvider';
import type { AlpacaRest } from './AlpacaRest';
import { MOVERS_MAX, isCommonStock, runBootstrap } from './bootstrap';
import { MoverRadar, barPrints, planLive, type RadarOptions } from './MoverRadar';
import { haltStateOf, parseAlpacaTimestamp, type AlpacaMessage } from './messages';

export interface AlpacaStreamOptions {
  keyId: string;
  secretKey: string;
  feed: 'iex' | 'sip' | 'test';
  sandbox: boolean;
  /** Subscribe to trading statuses (halts). Off by default until verified on your data plan. */
  statuses: boolean;
  /**
   * Subscribe to quotes (bid/ask, spread). On the free iex plan trades and quotes share one
   * 30-subscription limit (bars don't count; probed 2026-10-30), so quotes halve the symbols.
   */
  quotes: boolean;
  logger: Logger;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** Seeds prev close, today's session and history over REST; absent for the `test` feed. */
  rest?: AlpacaRest;
  /** Adds the market's top gainers to the subscription, up to `maxSymbols` in total. */
  movers?: { top: number; refreshMs: number; maxSymbols: number };
  /**
   * Watches every symbol's minute bars (free: bars don't count toward the plan limit) and
   * rotates the live trade slots to whatever is moving hardest. Needs `movers`.
   */
  radar?: RadarOptions;
}

/** Rows the radar and gainers list may add in a day; each is a scanner row followed by minute bars at least. */
const MAX_TRACKED = 300;
/** A live symbol keeps its slot at least this long before a hotter one can take it. */
const MIN_LIVE_MS = 2 * 60_000;
/** Points of % move a waiting symbol needs over the coldest live one to take its slot. */
const SWAP_MARGIN_PCT = 2;
/** Bars arrive in a burst just after each minute; rotation runs once the burst settles. */
const REBALANCE_DEBOUNCE_MS = 1_500;
const MINUTE = 60_000;


// Alpaca stream error codes that retrying cannot fix.
const FATAL_ERROR_CODES = new Set([
  401, // not authenticated
  402, // auth failed (bad keys)
  409, // insufficient subscription (e.g. sip feed on free plan)
]);

/**
 * Alpaca Market Data v2 stock stream.
 * Docs: https://docs.alpaca.markets/docs/real-time-stock-pricing-data
 *
 * Note: Alpaca allows ONE concurrent stream connection per account, which is why
 * all scanning happens server-side off this single connection (error 406 otherwise).
 */
export class AlpacaStreamProvider extends MarketDataProvider {
  readonly name = 'alpaca';
  private readonly socket: ReconnectingSocket;
  private readonly log: Logger;
  private authenticated = false;
  private started = false;
  private authentications = 0;
  private moversTimer: NodeJS.Timeout | null = null;
  private readonly radar: MoverRadar | null;
  /** Symbols with a trade subscription → when they got it. Without the radar, every symbol. */
  private readonly live = new Map<string, number>();
  /** Symbols asked for from outside (WATCHLIST): always live, never rotated out. */
  private readonly pinned = new Set<string>();
  /** Bar-only symbols → the first minute whose bar is folded into prints (it had no trades). */
  private readonly barOnlyFrom = new Map<string, number>();
  private gainersRank: string[] = [];
  private internalAdd = false;
  private rebalanceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: AlpacaStreamOptions) {
    super();
    this.log = opts.logger.child({ provider: this.name });
    this.radar = opts.radar && opts.movers && opts.rest ? new MoverRadar(opts.radar) : null;
    const host = opts.sandbox ? 'stream.data.sandbox.alpaca.markets' : 'stream.data.alpaca.markets';
    // The 24/7 test stream is a "feed" at /v2/test.
    this.socket = new ReconnectingSocket({
      url: `wss://${host}/v2/${opts.feed}`,
      name: 'alpaca-stocks',
      logger: opts.logger,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
      reconnectBaseMs: opts.reconnectBaseMs,
      reconnectMaxMs: opts.reconnectMaxMs,
    });

    this.socket.on('state', (state) => {
      if (state !== 'open') this.authenticated = false;
      this.setStatus(state);
    });
    this.socket.on('message', (data) => this.handleRaw(data));
  }

  start(): void {
    this.started = true;
    // Seed first so the first trades land on a store that knows yesterday's close.
    void this.bootstrap(this.symbols).finally(() => this.socket.start());
    if (this.opts.movers && this.opts.rest) {
      void this.discoverMovers();
      this.moversTimer = setInterval(() => void this.discoverMovers(), this.opts.movers.refreshMs);
    }
  }

  stop(): void {
    if (this.moversTimer) clearInterval(this.moversTimer);
    if (this.rebalanceTimer) clearTimeout(this.rebalanceTimer);
    this.moversTimer = this.rebalanceTimer = null;
    this.socket.stop();
  }

  /** Trade subscriptions the plan allows (trades and quotes share the limit; bars are free). */
  private get slots(): number {
    return Math.floor((this.opts.movers?.maxSymbols ?? Infinity) / (this.opts.quotes ? 2 : 1));
  }

  protected onSubscribe(symbols: string[]): void {
    if (!this.radar || !this.internalAdd) {
      const now = Date.now();
      for (const s of symbols) {
        if (this.radar) this.pinned.add(s);
        this.live.set(s, now);
      }
      // Otherwise the full set is sent once authentication succeeds.
      if (this.authenticated) this.sendTrades('subscribe', symbols);
    } else {
      // Tracked: a row followed by minute bars until the rotation gives it a live slot.
      for (const s of symbols) this.barOnlyFrom.set(s, 0);
      this.scheduleRebalance();
    }
    if (this.started) void this.bootstrap(symbols);
  }

  private track(symbols: string[]): void {
    this.internalAdd = true;
    try {
      this.subscribe(symbols);
    } finally {
      this.internalAdd = false;
    }
  }

  private async bootstrap(symbols: string[]): Promise<void> {
    const rest = this.opts.rest;
    if (!rest || !symbols.length) return;
    try {
      const seeded = await runBootstrap(rest, symbols, Date.now(), {
        history: (symbol, bars) => this.emit('history', symbol, bars),
        seed: (seed) => this.emit('seed', seed),
        reference: (ref) => this.emit('reference', ref),
      });
      this.log.info({ requested: symbols.length, seeded: seeded.length }, 'REST bootstrap done');
    } catch (err) {
      // Streaming still works without it; % change, gap and RVOL stay blank until it succeeds.
      this.log.warn({ err: (err as Error).message }, 'REST bootstrap failed');
    }
  }

  private async discoverMovers(): Promise<void> {
    const { rest, movers } = this.opts;
    if (!rest || !movers) return;
    try {
      // Ask for the longest list: warrants and rights are filtered out before taking the top N.
      const gainers = (await rest.topGainers(MOVERS_MAX)).filter(isCommonStock).slice(0, movers.top);
      if (this.radar) {
        this.gainersRank = gainers;
        const added = gainers.filter((s) => !this.subscribed.has(s)).slice(0, Math.max(0, MAX_TRACKED - this.subscribed.size));
        if (added.length) this.track(added);
        this.log.info({ gainers: gainers.length, added, tracked: this.subscribed.size, live: this.live.size }, 'movers refreshed');
        return;
      }
      // The cap counts trade and quote subscriptions; bars are free.
      const room = Math.floor(movers.maxSymbols / (this.opts.quotes ? 2 : 1)) - this.symbols.length;
      const added = gainers.filter((s) => !this.subscribed.has(s)).slice(0, Math.max(0, room));
      // Movers are only ever added: dropping one mid-session would leave a stale row in every scanner.
      if (added.length) this.subscribe(added);
      this.log.info({ gainers: gainers.length, added, total: this.symbols.length, cap: movers.maxSymbols }, 'movers refreshed');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'movers request failed');
    }
  }

  protected onUnsubscribe(symbols: string[]): void {
    const live = symbols.filter((s) => this.live.delete(s));
    symbols.forEach((s) => (this.pinned.delete(s), this.barOnlyFrom.delete(s)));
    if (this.authenticated) this.sendTrades('unsubscribe', live);
  }

  private scheduleRebalance(): void {
    if (!this.radar || this.rebalanceTimer) return;
    this.rebalanceTimer = setTimeout(() => {
      this.rebalanceTimer = null;
      this.rebalance(Date.now());
    }, REBALANCE_DEBOUNCE_MS);
  }

  /** Tracks the radar's fast movers and hands the live slots to the hottest tracked symbols. */
  private rebalance(now: number): void {
    const radar = this.radar;
    if (!radar) return;
    const room = Math.max(0, MAX_TRACKED - this.subscribed.size);
    const found = radar
      .candidates(now)
      .filter((c) => !this.subscribed.has(c.symbol) && isCommonStock(c.symbol))
      .slice(0, room);
    if (found.length) {
      this.log.info({ found: found.map((c) => `${c.symbol} ${c.movePct > 0 ? '+' : ''}${c.movePct.toFixed(1)}%`) }, 'radar: fast movers');
      this.track(found.map((c) => c.symbol));
    }
    const gainers = new Set(this.gainersRank);
    const plan = planLive({
      live: this.live,
      tracked: [...this.gainersRank.filter((s) => this.subscribed.has(s)), ...this.symbols.filter((s) => !gainers.has(s))],
      pinned: this.pinned,
      slots: this.slots,
      heat: (s) => radar.heat(s, now),
      now,
      minLiveMs: MIN_LIVE_MS,
      swapMargin: SWAP_MARGIN_PCT,
    });
    if (!plan.add.length && !plan.drop.length) return;
    // Rotation runs seconds into a minute (just after the bar burst), so the dropped symbol's bar
    // for this minute is folded in too: counting those seconds twice beats missing the minute.
    const thisMinute = Math.floor(now / MINUTE) * MINUTE;
    for (const s of plan.drop) {
      this.live.delete(s);
      this.barOnlyFrom.set(s, thisMinute);
    }
    for (const s of plan.add) {
      this.live.set(s, now);
      this.barOnlyFrom.delete(s);
    }
    if (this.authenticated) {
      this.sendTrades('unsubscribe', plan.drop);
      this.sendTrades('subscribe', plan.add);
    }
    const fmt = (s: string) => `${s} ${radar.heat(s, now).toFixed(1)}%`;
    this.log.info({ live: plan.add.map(fmt), barsOnly: plan.drop.map(fmt), slots: this.slots }, 'live slots rotated');
  }

  /** Trade (and quote / status) subscriptions. Without the radar's wildcard, bars ride along. */
  private sendTrades(action: 'subscribe' | 'unsubscribe', symbols: string[]): void {
    if (!symbols.length) return;
    this.socket.send({
      action,
      trades: symbols,
      ...(this.opts.quotes ? { quotes: symbols } : {}),
      ...(this.radar ? {} : { bars: symbols }),
      ...(this.opts.statuses ? { statuses: symbols } : {}),
    });
    this.log.info({ action, count: symbols.length }, 'subscription sent');
  }

  private onStreamBar(bar: Bar): void {
    this.radar?.onBar(bar);
    this.scheduleRebalance();
    if (!this.subscribed.has(bar.symbol)) return;
    const from = this.barOnlyFrom.get(bar.symbol);
    // No trades for this symbol: its bar stands in for them, so the row, VWAP and alerts move.
    if (from !== undefined && bar.timestamp >= from) for (const t of barPrints(bar)) this.emit('trade', t);
    this.emit('bar', bar);
  }

  private handleRaw(data: RawData): void {
    let messages: AlpacaMessage[];
    try {
      messages = JSON.parse(data.toString());
    } catch (err) {
      this.log.error({ err }, 'unparseable message');
      return;
    }

    for (const msg of messages) {
      switch (msg.T) {
        case 't':
          this.emit('trade', {
            symbol: msg.S,
            price: msg.p,
            size: msg.s,
            timestamp: parseAlpacaTimestamp(msg.t),
            exchange: msg.x,
            conditions: msg.c,
          });
          break;
        case 'q':
          this.emit('quote', {
            symbol: msg.S,
            bidPrice: msg.bp,
            bidSize: msg.bs,
            askPrice: msg.ap,
            askSize: msg.as,
            timestamp: parseAlpacaTimestamp(msg.t),
          });
          break;
        case 'b':
        case 'u': // updated bar (late trades corrected a bar already sent)
          this.onStreamBar({
            symbol: msg.S,
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v,
            vwap: msg.vw,
            tradeCount: msg.n,
            timestamp: parseAlpacaTimestamp(msg.t),
          });
          break;
        case 's': {
          const state = haltStateOf(msg.sc);
          if (state) {
            this.emit('tradingStatus', {
              symbol: msg.S,
              state,
              reasonCode: msg.rc,
              reason: msg.rm || undefined,
              timestamp: parseAlpacaTimestamp(msg.t),
            });
          }
          break;
        }
        case 'success':
          this.handleControl(msg.msg);
          break;
        case 'subscription':
          this.log.debug({ trades: msg.trades?.length, quotes: msg.quotes?.length }, 'subscription ack');
          break;
        case 'error':
          this.handleError(msg.code, msg.msg);
          break;
      }
    }
  }

  private handleControl(message: string): void {
    if (message === 'connected') {
      this.socket.send({ action: 'auth', key: this.opts.keyId, secret: this.opts.secretKey });
    } else if (message === 'authenticated') {
      this.authenticated = true;
      this.authentications++;
      this.setStatus('authenticated');
      this.log.info({ feed: this.opts.feed }, 'authenticated');
      // Restore the full subscription set (initial connect and every reconnect).
      this.sendTrades('subscribe', [...this.live.keys()]);
      if (this.radar) this.socket.send({ action: 'subscribe', bars: ['*'] });
      // After a reconnect, trades were missed: re-seed today's state.
      if (this.authentications > 1) void this.bootstrap(this.symbols);
    }
  }

  private handleError(code: number, message: string): void {
    this.log.error({ code, message }, 'alpaca stream error');
    this.setStatus('error', `${code}: ${message}`);
    if (FATAL_ERROR_CODES.has(code)) {
      this.log.fatal('non-recoverable error — stopping stream. Check keys / plan / ALPACA_FEED.');
      this.stop();
    } else if (code === 405) {
      this.log.error(
        { symbols: this.symbols.length, quotes: this.opts.quotes },
        'symbol limit exceeded: trades + quotes count against the plan limit (30 on free iex). Lower ALPACA_MAX_SYMBOLS / WATCHLIST or set ALPACA_QUOTES=false.',
      );
    } else if (code === 406) {
      // Connection limit: another client (another tab of this app, a notebook…) holds the slot.
      this.socket.drop('connection limit exceeded', 15_000);
    }
  }
}
