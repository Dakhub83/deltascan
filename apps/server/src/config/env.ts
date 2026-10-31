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
    ALPACA_STATUSES: bool(false),
    // Bid/ask quotes. On free iex, trades + quotes share the 30-subscription limit, so this halves the symbols.
    ALPACA_QUOTES: bool(false),
    // Top gainers added to the stream each refresh (0 = WATCHLIST only), up to ALPACA_MAX_SYMBOLS in total.
    ALPACA_MOVERS_TOP: z.coerce.number().int().min(0).max(50).default(20),
    ALPACA_MOVERS_REFRESH_SEC: int(300),
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

    DB_PATH: z.string().default('./data/scanner.db'),
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

export const env = parsed.data;
export type Env = typeof env;
