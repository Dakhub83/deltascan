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
  /** Bar start time (1-minute bars start on the minute). */
  timestamp: EpochMs;
  session?: TradeSession;
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
/** US equities sessions in ET: pre 04:00–09:30, regular 09:30–16:00, post 16:00–20:00. */
export type MarketSession = 'pre' | 'regular' | 'post' | 'closed';
/** The session a trade belongs to (a print outside 04:00–20:00 counts as pre or post). */
export type TradeSession = Exclude<MarketSession, 'closed'>;

export interface SessionSeed {
  symbol: string;
  prevClose: number;
  /** Regular-session fields; null before the 09:30 open. */
  open: number | null;
  high: number | null;
  low: number | null;
  last: number;
  volume: number;
  vwap: number | null;
  tradeCount?: number;
  /** Today's 16:00 close, once the regular session has ended. */
  close?: number;
  pre?: ExtendedSessionSeed;
  post?: ExtendedSessionSeed;
}

export interface ExtendedSessionSeed {
  volume: number;
  high: number;
  low: number;
  last: number;
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
  /** Pre-market (04:00–09:30 ET). `preChangePct` is the last pre-market print vs prevClose. */
  preVolume: number;
  preHigh: number | null;
  preLow: number | null;
  preLast: number | null;
  preChangePct: number | null;
  /** Today's 16:00 close: the last regular-session print. */
  regularClose: number | null;
  /** After hours (16:00–20:00 ET). `postChangePct` is vs `regularClose`. */
  postVolume: number;
  postHigh: number | null;
  postLow: number | null;
  postChangePct: number | null;
  /** Short-side setup stage, worked out from completed 1-minute bars; null when not in play. */
  fade: FadeState | null;
  lastTradeAt: EpochMs | null;
  updatedAt: EpochMs;
}

// ── Fade setups (short side) ──

/** Spike → Extension → Rejection → Confirmation → Fade, plus a backside bounce into VWAP. */
export type FadeStage = 'spike' | 'extension' | 'rejection' | 'confirmation' | 'fade' | 'vwap-bounce';

export interface FadeState {
  stage: FadeStage;
  /** When the current stage began. */
  since: EpochMs;
  /** High of the current session (pre-market or regular) and the start of the bar that made it. */
  high: number;
  highAt: EpochMs;
  /** High of the rejection candle: a new high above it invalidates the setup. */
  rejectionHigh: number | null;
  /** The rejection candle's low: a close below it confirms the rejection. */
  rejectionLow: number | null;
  /** The rejection candle's low; a close below it confirmed the rejection. */
  confirmLevel: number | null;
  /** High of the last failed backside bounce: the risk for an add. */
  lowerHigh: number | null;
  /** Closed a 1-minute bar under VWAP since topping (regular hours): the main add. */
  vwapBroken: boolean;
}

/** A short-side signal on the bar that produced it; kept for the chart even when it didn't alert. */
export interface FadeSignal {
  type: AlertType;
  /** Start of the 1-minute bar. */
  barTime: EpochMs;
  price: number;
  detail: string;
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
  'topping',
  'rejection_confirmed',
  'vwap_break',
  'failed_bounce',
  'vwap_bounce',
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
  /** The session the server is classifying trades into (simulated on the mock feed). */
  session: MarketSession;
}

export type ServerMessage =
  | {
      type: 'hello';
      data: {
        snapshots: SymbolSnapshot[];
        alerts: Alert[];
        halts: HaltEvent[];
        status: ProviderStatus | null;
        session: MarketSession;
        serverTime: EpochMs;
      };
    }
  | { type: 'snapshots'; data: SymbolSnapshot[] }
  /** Latest 1-minute bar of each symbol the client charts (see ClientMessage 'chart'). */
  | { type: 'bars'; data: Bar[] }
  | { type: 'alerts'; data: Alert[] }
  /** New or updated halts (upsert by id). */
  | { type: 'halts'; data: HaltEvent[] }
  | { type: 'status'; data: ProviderStatus }
  | { type: 'stats'; data: ServerStats };

/** Browser → server. */
export type ClientMessage =
  /** Replaces the set of symbols this client receives live 1-minute bars for. */
  { type: 'chart'; symbols: string[] };

// ── Dilution (SEC EDGAR) ──

/** One reported XBRL value and when it was reported. Values are not split-adjusted. */
export interface ReportedValue {
  value: number;
  /** Period end (balance-sheet date or cover-page date). */
  asOf: string;
  form: string;
  filed: string;
}

export type DilutionFilingKind = 'offering' | 'registration' | 'effective' | 'equity-sale' | 'agreement' | 'reverse-split' | 'delisting' | 'late' | 'comp-plan';

export interface DilutionFiling {
  form: string;
  filed: string;
  kind: DilutionFilingKind;
  /** Plain-English description, e.g. "Unregistered sale of equity". */
  label: string;
  url: string;
  /** Offering size read from the prospectus text; null when it isn't stated or couldn't be read. */
  amount?: OfferingAmount | null;
}

export interface OfferingAmount {
  /** Dollars; null for resale prospectuses (the company receives nothing). */
  value: number | null;
  /** ATMs and shelf takedowns state a maximum ("up to $10M"), not a raise. */
  upTo: boolean;
  resale: boolean;
}

export interface ReverseSplit {
  /** Effective date from the filing, else its filing date, else the period of the share-count drop. */
  date: string;
  /** Old shares per new share: 5 for a 1-for-5. Estimated when `source` is 'share-count'. */
  ratio: number | null;
  source: 'filing' | 'share-count';
  /** Shares outstanding right after the split, when the filing states it. */
  sharesAfter: number | null;
  url: string | null;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskReason {
  points: number;
  text: string;
}

export interface DilutionReport {
  symbol: string;
  cik: string;
  name: string;
  exchange: string | null;
  industry: string | null;
  /** Broad sector derived from the SIC code ("Industrials", "Health Care"). */
  sector: string | null;
  location: string | null;
  sharesOutstanding: ReportedValue | null;
  /** Cover-page share counts, oldest first. `adjusted` restates earlier counts for later reverse splits with a known ratio. */
  shareHistory: { asOf: string; value: number; adjusted: number }[];
  /** Growth from `shareGrowthSince` to the latest count, on split-adjusted counts; resets at drops it can't explain. */
  shareGrowthPct: number | null;
  shareGrowthSince: string | null;
  /** True when the growth figure spans a reverse split that was adjusted for. */
  shareGrowthSplitAdjusted: boolean;
  /** Reverse splits in the last two years, newest first. */
  reverseSplits: ReverseSplit[];
  /** Date of a share-count drop of more than 40% (likely a reverse split), if any in the history. */
  reverseSplitSuspected: string | null;
  cash: ReportedValue | null;
  /** Average monthly operating cash burn over the latest reported period; null if cash-flow positive or unknown. */
  monthlyBurn: number | null;
  burnPeriod: { start: string; end: string } | null;
  cashFlowPositive: boolean;
  runwayMonths: number | null;
  /** Banks and lenders: operating cash flow includes loans made, so burn and runway are left out. */
  financial: boolean;
  warrants: ReportedValue | null;
  preferredShares: ReportedValue | null;
  convertibleDebt: ReportedValue | null;
  /** Dilution-related filings from the last 12 months, newest first. */
  filings: DilutionFiling[];
  /** 8-K item 3.02 filings since the latest balance sheet: raises the cash figure doesn't include yet. */
  equitySalesSinceBalanceSheet: number;
  risk: { score: number; level: RiskLevel; reasons: RiskReason[] };
  /** Per-area ratings for the quote card; null when the SEC data can't judge that area. */
  ratings: Record<'offering' | 'dilution' | 'frequency' | 'cashNeed' | 'warrants' | 'compliance', RiskLevel | null>;
  /** Files 20-F / 40-F / 6-K: a foreign private issuer (most ADRs are). */
  foreignFiler: boolean;
  fetchedAt: EpochMs;
}

// ── Company profile & news ──

export interface NewsItem {
  headline: string;
  summary: string | null;
  url: string;
  /** "SEC 8-K" for press releases, otherwise the newswire's source name. */
  source: string;
  publishedAt: EpochMs;
  kind: 'press-release' | 'newswire';
}

export interface CompanyProfile {
  symbol: string;
  /** Opening of the Business section of the latest annual report (10-K Item 1 / 20-F Item 4). */
  description: string | null;
  descriptionSource: { form: string; filed: string; url: string } | null;
  /** Country of the business address; "United States" for US states. */
  country: string | null;
  incorporatedIn: string | null;
  /** True when the annual report's cover lists American Depositary Shares; null if unknown. */
  adr: boolean | null;
  /** Newest first: SEC press releases, plus Alpaca news when keys are configured. */
  news: NewsItem[];
  newsSources: ('sec' | 'alpaca')[];
  fetchedAt: EpochMs;
}
