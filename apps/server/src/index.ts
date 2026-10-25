import { env } from './config/env';
import { logger } from './lib/logger';
import { SymbolStore } from './cache/SymbolStore';
import { IngestionService } from './ingestion/IngestionService';
import { AlertEngine } from './scanner/AlertEngine';
import { HaltTracker } from './scanner/HaltTracker';
import { ClientGateway } from './gateway/ClientGateway';
import { marketSessionAt, mockSessionFraction, regularSessionFraction, tradeSessionAt } from './market/sessionClock';

const STATS_LOG_INTERVAL_MS = 30_000;

const mock = env.DATA_PROVIDER === 'mock';
// The mock simulates one session regardless of the wall clock.
const mockFraction = env.MOCK_SESSION === 'post' ? () => 1 : mockSessionFraction(env.MOCK_SESSION_START);
const store = new SymbolStore({
  sessionFraction: mock ? mockFraction : regularSessionFraction,
  sessionOf: mock ? () => env.MOCK_SESSION : tradeSessionAt,
});
const currentSession = () => (mock ? env.MOCK_SESSION : marketSessionAt(Date.now()));
const alerts = new AlertEngine();
const halts = new HaltTracker({
  // The mock shortens LULD pauses; keep the Halts window countdown honest.
  luldPauseMs: mock ? env.MOCK_HALT_SECONDS * 1000 : undefined,
  onHalt: (h) =>
    alerts.raise(
      'halt',
      { symbol: h.symbol, price: h.haltPrice ?? 0, timestamp: h.haltedAt },
      h.haltChangePct,
      h.direction ? `${h.reason} (${h.direction})` : h.reason,
    ),
  onResume: (h) =>
    alerts.raise(
      'resume',
      { symbol: h.symbol, price: h.haltPrice ?? 0, timestamp: h.resumedAt ?? Date.now() },
      h.haltChangePct,
      h.reason,
    ),
});

let gateway: ClientGateway | null = null;
const ingestion = new IngestionService(env, store, alerts, halts, logger, (status) =>
  gateway?.publishStatus(status),
);

let lastStats = { tradesPerSec: 0, quotesPerSec: 0, symbols: 0 };
const statsSampler = setInterval(() => (lastStats = ingestion.takeStats()), 1_000);
const momentumSampler = setInterval(() => store.sampleMomentum(), 1_000);

gateway = new ClientGateway({
  port: env.SERVER_PORT,
  broadcastIntervalMs: env.BROADCAST_INTERVAL_MS,
  store,
  alerts,
  halts,
  getStatus: () => ingestion.status,
  getStats: () => ({ ...lastStats, session: currentSession() }),
  getSession: currentSession,
  logger,
});

logger.info({ provider: env.DATA_PROVIDER, feed: env.ALPACA_FEED }, 'starting scanner server');
ingestion.start();
gateway.start();

const statsLogger = setInterval(() => {
  logger.info({ state: ingestion.status?.state, ...lastStats, cached: store.size }, 'throughput');
}, STATS_LOG_INTERVAL_MS);

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  clearInterval(statsSampler);
  clearInterval(momentumSampler);
  clearInterval(statsLogger);
  gateway?.stop();
  ingestion.stop();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
