import { EventEmitter } from 'node:events';
import type {
  Bar,
  ConnectionState,
  ProviderStatus,
  Quote,
  ReferenceData,
  SessionSeed,
  Trade,
  TradingStatus,
} from '@deltascan/shared';

export type ProviderEvents = {
  trade: [trade: Trade];
  quote: [quote: Quote];
  bar: [bar: Bar];
  /** Today's session-to-date state, emitted before streaming (snapshot bootstrap). */
  seed: [seed: SessionSeed];
  reference: [ref: ReferenceData];
  /** One symbol's recent 1-minute bars, oldest first (startup backfill). */
  history: [symbol: string, bars: Bar[]];
  /** Exchange trading status: halts, quotation-only, resumptions. */
  tradingStatus: [status: TradingStatus];
  status: [status: ProviderStatus];
};

/**
 * Every data source (Alpaca, Polygon, mock…) normalizes its feed into these events.
 * Implementations own the desired-subscription set and must restore it after reconnects.
 */
export abstract class MarketDataProvider extends EventEmitter<ProviderEvents> {
  abstract readonly name: string;
  protected readonly subscribed = new Set<string>();

  abstract start(): void;
  abstract stop(): void;

  subscribe(symbols: string[]): void {
    const added = symbols.map((s) => s.toUpperCase()).filter((s) => !this.subscribed.has(s));
    added.forEach((s) => this.subscribed.add(s));
    if (added.length) this.onSubscribe(added);
  }

  unsubscribe(symbols: string[]): void {
    const removed = symbols.map((s) => s.toUpperCase()).filter((s) => this.subscribed.delete(s));
    if (removed.length) this.onUnsubscribe(removed);
  }

  get symbols(): string[] {
    return [...this.subscribed];
  }

  /** Called with only the newly-added symbols. */
  protected abstract onSubscribe(symbols: string[]): void;
  protected abstract onUnsubscribe(symbols: string[]): void;

  protected setStatus(state: ConnectionState, message?: string): void {
    this.emit('status', { provider: this.name, state, message, at: Date.now() });
  }
}
