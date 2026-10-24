import { env } from './config/env';
import { logger } from './lib/logger';
import { SymbolStore } from './cache/SymbolStore';
import { IngestionService } from './ingestion/IngestionService';
import { AlertEngine } from './scanner/AlertEngine';
import { ClientGateway } from './gateway/ClientGateway';
import { mockSessionFraction, regularSessionFraction } from './market/sessionClock';

const STATS_LOG_INTERVAL_MS = 30_000;

const store = new SymbolStore({
  sessionFraction:
    env.DATA_PROVIDER === 'mock' ? mockSessionFraction(env.MOCK_SESSION_START) : regularSessionFraction,
});
const alerts = new AlertEngine();

let gateway: ClientGateway | null = null;
const ingestion = new IngestionService(env, store, alerts, logger, (status) => gateway?.publishStatus(status));

let lastStats = { tradesPerSec: 0, quotesPerSec: 0, symbols: 0 };
const statsSampler = setInterval(() => (lastStats = ingestion.takeStats()), 1_000);

gateway = new ClientGateway({
  port: env.SERVER_PORT,
  broadcastIntervalMs: env.BROADCAST_INTERVAL_MS,
  store,
  alerts,
  getStatus: () => ingestion.status,
  getStats: () => lastStats,
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
  clearInterval(statsLogger);
  gateway?.stop();
  ingestion.stop();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
