import type { RawData } from 'ws';
import type { Logger } from '../../../lib/logger';
import { ReconnectingSocket } from '../../ReconnectingSocket';
import { MarketDataProvider } from '../MarketDataProvider';
import type { AlpacaRest } from './AlpacaRest';
import { MOVERS_MAX, isCommonStock, runBootstrap } from './bootstrap';
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
}


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

  constructor(private readonly opts: AlpacaStreamOptions) {
    super();
    this.log = opts.logger.child({ provider: this.name });
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
    this.moversTimer = null;
    this.socket.stop();
  }

  protected onSubscribe(symbols: string[]): void {
    if (this.authenticated) this.sendSubscription('subscribe', symbols);
    // Otherwise the full set is sent once authentication succeeds.
    if (this.started) void this.bootstrap(symbols);
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
    if (this.authenticated) this.sendSubscription('unsubscribe', symbols);
  }

  private sendSubscription(action: 'subscribe' | 'unsubscribe', symbols: string[]): void {
    if (!symbols.length) return;
    this.socket.send({
      action,
      trades: symbols,
      ...(this.opts.quotes ? { quotes: symbols } : {}),
      bars: symbols,
      ...(this.opts.statuses ? { statuses: symbols } : {}),
    });
    this.log.info({ action, count: symbols.length }, 'subscription sent');
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
          this.emit('bar', {
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
      this.sendSubscription('subscribe', this.symbols);
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
