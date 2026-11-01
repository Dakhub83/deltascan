import { existsSync } from 'node:fs';
import { env, WEB_DIST } from './config/env';
import { logger } from './lib/logger';
import { SymbolStore } from './cache/SymbolStore';
import { IngestionService } from './ingestion/IngestionService';
import { AlertEngine } from './scanner/AlertEngine';
import { HaltTracker } from './scanner/HaltTracker';
import { FadeDetector } from './scanner/FadeDetector';
import { IndicatorEngine } from './scanner/indicators';
import { SecClient } from './fundamentals/SecClient';
import { AlpacaNews } from './fundamentals/AlpacaNews';
import { ProfileService } from './fundamentals/ProfileService';
import { ClientGateway } from './gateway/ClientGateway';
import { AppDb } from './db/AppDb';
import { Auth } from './auth/Auth';
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

const db = new AppDb(env.DB_PATH);
const auth = new Auth(db, { required: env.AUTH_REQUIRED, allowSignup: env.ALLOW_SIGNUP, secureCookie: env.COOKIE_SECURE });
// The day's feed survives a restart (New Highs counts, the alert window, chart markers).
alerts.restore(db.alerts({ since: Date.now() - 24 * 60 * 60_000, limit: 500 }));
if (!env.AUTH_REQUIRED) logger.warn('AUTH_REQUIRED is off: anyone who can reach this server can use it');

const sec = env.SEC_USER_AGENT ? new SecClient(env.SEC_USER_AGENT, logger) : null;
if (!sec) logger.warn('SEC_USER_AGENT not set: the Dilution window is disabled');
// News works with Alpaca keys even when streaming the mock feed.
const alpacaNews = env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY ? new AlpacaNews(env.ALPACA_KEY_ID, env.ALPACA_SECRET_KEY) : null;
const profiles = new ProfileService(sec, alpacaNews, logger);

let gateway: ClientGateway | null = null;
const ingestion = new IngestionService(env, store, alerts, halts, logger, (status) =>
  gateway?.publishStatus(status),
);

let lastStats = { tradesPerSec: 0, quotesPerSec: 0, symbols: 0 };
const statsSampler = setInterval(() => (lastStats = ingestion.takeStats()), 1_000);
const momentumSampler = setInterval(() => store.sampleMomentum(), 1_000);
const fades = new FadeDetector((type, symbol, price, detail) =>
  alerts.raise(type, { symbol, price, timestamp: Date.now() }, store.get(symbol)?.changePct ?? null, detail),
);
const indicators = new IndicatorEngine();
// Only newly completed 1-minute bars are processed, so this stays cheap.
const fadeSampler = setInterval(() => {
  for (const s of store.all()) {
    const bars = store.getBars(s.symbol);
    store.setFade(s.symbol, fades.evaluate(s, bars));
    store.setIndicators(s.symbol, indicators.evaluate(s.symbol, bars));
  }
}, 1_000);

gateway = new ClientGateway({
  port: env.SERVER_PORT,
  broadcastIntervalMs: env.BROADCAST_INTERVAL_MS,
  store,
  alerts,
  halts,
  getStatus: () => ingestion.status,
  getStats: () => ({ ...lastStats, session: currentSession() }),
  getSession: currentSession,
  dilution: sec ? (symbol) => sec.dilution(symbol) : undefined,
  profile: profiles.enabled ? (symbol) => profiles.profile(symbol) : undefined,
  fadeSignals: (symbol) => fades.signals(symbol),
  app: { auth, db, onWatch: (symbol) => ingestion.provider.track([symbol]), trustProxy: env.TRUST_PROXY },
  onAlerts: (list) => {
    try {
      db.insertAlerts(list);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'saving alerts failed');
    }
  },
  webRoot: env.SERVE_WEB ? WEB_DIST : undefined,
  logger,
});
if (env.SERVE_WEB && !existsSync(WEB_DIST)) logger.warn({ dir: WEB_DIST }, 'SERVE_WEB is on but the web app is not built: run npm run build');

logger.info({ provider: env.DATA_PROVIDER, feed: env.ALPACA_FEED }, 'starting scanner server');
// Every user's watchlist stays in the feed.
ingestion.provider.track(db.allWatchlistSymbols());
ingestion.start();
gateway.start();

const statsLogger = setInterval(() => {
  logger.info({ state: ingestion.status?.state, ...lastStats, cached: store.size }, 'throughput');
}, STATS_LOG_INTERVAL_MS);

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  clearInterval(statsSampler);
  clearInterval(momentumSampler);
  clearInterval(fadeSampler);
  clearInterval(statsLogger);
  gateway?.stop();
  ingestion.stop();
  db.close();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
