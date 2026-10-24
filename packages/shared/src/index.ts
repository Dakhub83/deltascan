// Types shared by the server and the web client.
// Provider-specific wire formats are normalized into these shapes at the edge.

/** Epoch milliseconds (UTC). */
export type EpochMs = number;

export interface Trade {
  symbol: string;
  price: number;
  size: number;
  timestamp: EpochMs;
  exchange?: string;
  conditions?: string[];
}

export interface Quote {
  symbol: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  timestamp: EpochMs;
}

/** Aggregated bar. `timestamp` is the bar's start time. */
export interface Bar {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
  timestamp: EpochMs;
}

/** Slow-moving per-symbol data (refreshed daily): fundamentals and volume baselines. */
export interface ReferenceData {
  symbol: string;
  name?: string;
  sector?: string;
  floatShares?: number;
  marketCap?: number;
  shortInterestPct?: number;
  /** Average full-day volume (e.g. 30-day), the RVOL baseline. */
  avgVolume?: number;
}

/** Today's session state up to "now", used to seed the cache before streaming starts. */
export interface SessionSeed {
  symbol: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
  vwap: number;
  tradeCount?: number;
}

/** Live per-symbol state maintained by the server's in-memory cache. */
export interface SymbolSnapshot {
  symbol: string;
  name: string | null;
  sector: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number;
  vwap: number | null;
  tradeCount: number;
  prevClose: number | null;
  changePct: number | null;
  gapPct: number | null;
  /** Volume relative to the expected volume at this time of day. */
  rvol: number | null;
  floatShares: number | null;
  marketCap: number | null;
  shortInterestPct: number | null;
  avgVolume: number | null;
  /** % change over the last 1 / 5 minutes (or since the oldest sample, if less history). */
  chg1mPct: number | null;
  chg5mPct: number | null;
  halted: boolean;
  lastTradeAt: EpochMs | null;
  updatedAt: EpochMs;
}

// ── Trading halts ──

export type HaltState = 'halted' | 'quoting' | 'resumed';

/** Normalized exchange trading-status message (provider → server). */
export interface TradingStatus {
  symbol: string;
  state: HaltState;
  reasonCode: string;
  reason?: string;
  /** Price at the moment of the event, when the provider knows it (halt price / resume print). */
  price?: number;
  /** LULD band hit, when the provider knows it; otherwise inferred from recent momentum. */
  direction?: 'up' | 'down';
  timestamp: EpochMs;
}

/** One halt, from pause to resumption. Updated in place as it progresses. */
export interface HaltEvent {
  id: string;
  symbol: string;
  state: HaltState;
  reasonCode: string;
  reason: string;
  /** LULD pauses: which band was hit. */
  direction: 'up' | 'down' | null;
  haltedAt: EpochMs;
  /** Expected resumption (LULD pauses are 5 minutes), null when open-ended (e.g. news). */
  expectedResumeAt: EpochMs | null;
  resumedAt: EpochMs | null;
  haltPrice: number | null;
  haltChangePct: number | null;
  resumePrice: number | null;
  /** First print after resumption vs. halt price. */
  resumeGapPct: number | null;
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'authenticated'
  | 'reconnecting'
  | 'stopped'
  | 'error';

export interface ProviderStatus {
  provider: string;
  state: ConnectionState;
  message?: string;
  at: EpochMs;
}

// ── Alerts ──

export const ALERT_TYPES = [
  'new_high',
  'new_low',
  'vwap_reclaim',
  'vwap_loss',
  'volume_spike',
  'block_trade',
  'halt',
  'resume',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface Alert {
  id: string;
  type: AlertType;
  symbol: string;
  price: number;
  /** Human-readable detail, e.g. "5.2x avg 1-min volume". */
  detail: string;
  /** Alert-specific magnitude used for sorting/filtering (size, multiple, etc.). */
  value?: number;
  changePct: number | null;
  timestamp: EpochMs;
}

// ── Server → client protocol ──

export interface ServerStats {
  tradesPerSec: number;
  quotesPerSec: number;
  symbols: number;
}

export type ServerMessage =
  | {
      type: 'hello';
      data: {
        snapshots: SymbolSnapshot[];
        alerts: Alert[];
        halts: HaltEvent[];
        status: ProviderStatus | null;
        serverTime: EpochMs;
      };
    }
  | { type: 'snapshots'; data: SymbolSnapshot[] }
  | { type: 'alerts'; data: Alert[] }
  /** New or updated halts (upsert by id). */
  | { type: 'halts'; data: HaltEvent[] }
  | { type: 'status'; data: ProviderStatus }
  | { type: 'stats'; data: ServerStats };
