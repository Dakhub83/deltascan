import type { ProviderStatus, ServerStats } from '@deltascan/shared';
import type { Env } from '../config/env';
import type { Logger } from '../lib/logger';
import type { SymbolStore } from '../cache/SymbolStore';
import type { AlertEngine, PriorState } from '../scanner/AlertEngine';
import type { HaltTracker } from '../scanner/HaltTracker';
import type { MarketDataProvider } from './providers/MarketDataProvider';
import { AlpacaStreamProvider } from './providers/alpaca/AlpacaStreamProvider';
import { MockProvider } from './providers/mock/MockProvider';

/** Wires a market data provider into the local cache and alert engine, and tracks throughput. */
export class IngestionService {
  readonly provider: MarketDataProvider;
  status: ProviderStatus | null = null;
  private counts = { trades: 0, quotes: 0 };
  private windowStart = Date.now();
  private readonly prior: PriorState = { high: null, low: null, last: null, vwap: null };

  constructor(
    private readonly env: Env,
    private readonly store: SymbolStore,
    private readonly alerts: AlertEngine,
    private readonly halts: HaltTracker,
    private readonly logger: Logger,
    private readonly onStatus: (status: ProviderStatus) => void = () => {},
  ) {
    this.provider = createProvider(env, logger);

    this.provider.on('trade', (t) => {
      this.counts.trades++;
      const before = this.store.get(t.symbol);
      // Reused object: avoids an allocation per trade on the hot path.
      this.prior.high = before?.high ?? null;
      this.prior.low = before?.low ?? null;
      this.prior.last = before?.last ?? null;
      this.prior.vwap = before?.vwap ?? null;
      this.store.applyTrade(t);
      const after = this.store.get(t.symbol);
      if (after) this.alerts.onTrade(t, this.prior, after);
      this.halts.onTrade(t);
    });
    this.provider.on('tradingStatus', (s) => {
      this.halts.onStatus(s, this.store.get(s.symbol));
      this.store.setHalted(s.symbol, this.halts.isHalted(s.symbol));
    });
    this.provider.on('quote', (q) => {
      this.counts.quotes++;
      this.store.applyQuote(q);
    });
    this.provider.on('bar', (b) => this.store.applyBar(b));
    this.provider.on('seed', (s) => this.store.applySeed(s));
    this.provider.on('reference', (r) => this.store.applyReference(r));
    this.provider.on('status', (s) => {
      this.status = s;
      this.logger.debug({ status: s }, 'provider status');
      this.onStatus(s);
    });
  }

  start(): void {
    const symbols = this.env.DATA_PROVIDER === 'mock' ? MockProvider.defaultSymbols : this.env.WATCHLIST;
    this.provider.subscribe(symbols);
    this.provider.start();
  }

  stop(): void {
    this.provider.stop();
  }

  /** Throughput since the previous call. */
  takeStats(): ServerStats {
    const now = Date.now();
    const secs = Math.max(0.001, (now - this.windowStart) / 1000);
    const stats: ServerStats = {
      symbols: this.provider.symbols.length,
      tradesPerSec: Math.round(this.counts.trades / secs),
      quotesPerSec: Math.round(this.counts.quotes / secs),
    };
    this.counts = { trades: 0, quotes: 0 };
    this.windowStart = now;
    return stats;
  }
}

function createProvider(env: Env, logger: Logger): MarketDataProvider {
  const connection = {
    logger,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: env.HEARTBEAT_TIMEOUT_MS,
    reconnectBaseMs: env.RECONNECT_BASE_MS,
    reconnectMaxMs: env.RECONNECT_MAX_MS,
  };

  switch (env.DATA_PROVIDER) {
    case 'alpaca':
      return new AlpacaStreamProvider({
        ...connection,
        keyId: env.ALPACA_KEY_ID!,
        secretKey: env.ALPACA_SECRET_KEY!,
        feed: env.ALPACA_FEED,
        sandbox: env.ALPACA_SANDBOX,
        statuses: env.ALPACA_STATUSES,
      });
    case 'mock':
      return new MockProvider({
        logger,
        ticksPerSecond: env.MOCK_TICKS_PER_SECOND,
        startFraction: env.MOCK_SESSION_START,
        haltSeconds: env.MOCK_HALT_SECONDS,
      });
  }
}
