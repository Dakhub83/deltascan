import type { RawData } from 'ws';
import type { Logger } from '../../../lib/logger';
import { ReconnectingSocket } from '../../ReconnectingSocket';
import { MarketDataProvider } from '../MarketDataProvider';
import { haltStateOf, parseAlpacaTimestamp, type AlpacaMessage } from './messages';

export interface AlpacaStreamOptions {
  keyId: string;
  secretKey: string;
  feed: 'iex' | 'sip' | 'test';
  sandbox: boolean;
  /** Subscribe to trading statuses (halts). Off by default until verified on your data plan. */
  statuses: boolean;
  logger: Logger;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
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
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  protected onSubscribe(symbols: string[]): void {
    if (this.authenticated) this.sendSubscription('subscribe', symbols);
    // Otherwise the full set is sent once authentication succeeds.
  }

  protected onUnsubscribe(symbols: string[]): void {
    if (this.authenticated) this.sendSubscription('unsubscribe', symbols);
  }

  private sendSubscription(action: 'subscribe' | 'unsubscribe', symbols: string[]): void {
    if (!symbols.length) return;
    this.socket.send({
      action,
      trades: symbols,
      quotes: symbols,
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
      this.setStatus('authenticated');
      this.log.info({ feed: this.opts.feed }, 'authenticated');
      // Restore the full subscription set (initial connect and every reconnect).
      this.sendSubscription('subscribe', this.symbols);
    }
  }

  private handleError(code: number, message: string): void {
    this.log.error({ code, message }, 'alpaca stream error');
    this.setStatus('error', `${code}: ${message}`);
    if (FATAL_ERROR_CODES.has(code)) {
      this.log.fatal('non-recoverable error — stopping stream. Check keys / plan / ALPACA_FEED.');
      this.stop();
    } else if (code === 406) {
      // Connection limit: another client (another tab of this app, a notebook…) holds the slot.
      this.socket.drop('connection limit exceeded', 15_000);
    }
  }
}
