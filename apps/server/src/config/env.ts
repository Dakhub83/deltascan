import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// .env lives at the repo root, regardless of which workspace runs the process.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
loadDotenv({ path: resolve(repoRoot, '.env') });

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true');

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const symbolList = z
  .string()
  .default('AAPL,TSLA,NVDA,AMD,SPY,QQQ')
  .transform((s) =>
    s
      .split(',')
      .map((sym) => sym.trim().toUpperCase())
      .filter(Boolean),
  );

const schema = z
  .object({
    DATA_PROVIDER: z.enum(['alpaca', 'mock']).default('mock'),

    ALPACA_KEY_ID: z.string().optional(),
    ALPACA_SECRET_KEY: z.string().optional(),
    ALPACA_FEED: z.enum(['iex', 'sip', 'test']).default('iex'),
    ALPACA_SANDBOX: bool(false),
    ALPACA_PAPER: bool(true),
    ALPACA_STATUSES: bool(true),
    // Bid/ask quotes. On free iex, trades + quotes share the 30-subscription limit, so this halves the symbols.
    ALPACA_QUOTES: bool(false),
    // Top gainers added to the stream each refresh (0 = WATCHLIST only), up to ALPACA_MAX_SYMBOLS in total.
    ALPACA_MOVERS_TOP: z.coerce.number().int().min(0).max(50).default(20),
    ALPACA_MOVERS_REFRESH_SEC: int(60),
    // Watch every symbol's minute bars (free) and rotate live slots to the fastest movers.
    ALPACA_RADAR: bool(true),
    // A move of this many % (up or down) inside 5 minutes puts a stock on the radar.
    ALPACA_RADAR_MOVE_PCT: z.coerce.number().positive().default(4),
    // The previous session's top after-hours gainers added as rows each morning (0 = off).
    ALPACA_PREV_AH_TOP: z.coerce.number().int().min(0).max(100).default(30),
    // Minimum after-hours gain (vs the 4 PM close) for that list.
    ALPACA_PREV_AH_MIN_PCT: z.coerce.number().positive().default(5),
    // Trade + quote subscriptions allowed by the plan (bars don't count): 30 on free iex.
    ALPACA_MAX_SYMBOLS: int(30),

    POLYGON_API_KEY: z.string().optional(),
    FINNHUB_API_KEY: z.string().optional(),
    // SEC asks every client to identify itself with a contact email; requests without one get 403.
    SEC_USER_AGENT: z.string().optional(),

    WATCHLIST: symbolList,

    SERVER_PORT: int(4000),
    BROADCAST_INTERVAL_MS: int(250),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    HEARTBEAT_INTERVAL_MS: int(15_000),
    HEARTBEAT_TIMEOUT_MS: int(10_000),
    RECONNECT_BASE_MS: int(1_000),
    RECONNECT_MAX_MS: int(30_000),

    MOCK_TICKS_PER_SECOND: int(200),
    MOCK_SESSION_START: z.coerce.number().min(0).max(1).default(0.35),
    MOCK_SESSION: z.enum(['pre', 'regular', 'post']).default('regular'),
    MOCK_HALT_SECONDS: int(90),

    // Relative paths are from the repo root.
    DB_PATH: z.string().default('./data/scanner.db'),

    // Sign-in for every page, API call and the data socket. Off: a single built-in local account.
    AUTH_REQUIRED: bool(false),
    // Anyone may create an account. The first account can always be created.
    ALLOW_SIGNUP: bool(false),
    // Mark the session cookie Secure: set when the site is served over HTTPS.
    COOKIE_SECURE: bool(false),
    // Behind a reverse proxy: trust X-Forwarded-For for the client address (sign-in rate limit).
    TRUST_PROXY: bool(false),
    // Serve the built web app (apps/web/dist) from this server: production, after `npm run build`.
    SERVE_WEB: bool(false),
  })
  .superRefine((env, ctx) => {
    if (env.DATA_PROVIDER === 'alpaca' && (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ALPACA_KEY_ID and ALPACA_SECRET_KEY are required when DATA_PROVIDER=alpaca',
      });
    }
  });

// Treat empty strings from the template (`ALPACA_KEY_ID=`) as unset.
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
);

const parsed = schema.safeParse(rawEnv);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = { ...parsed.data, DB_PATH: resolve(repoRoot, parsed.data.DB_PATH) };
/** The built web app, served when SERVE_WEB is on. */
export const WEB_DIST = resolve(repoRoot, 'apps/web/dist');
export type Env = typeof env;
