import type { Bar, Quote, ReferenceData, SessionSeed, SymbolSnapshot, Trade, TradeSession } from '@deltascan/shared';

/** About 2½ days of extended-hours 1-minute bars (16 h × 60 per day). */
const DEFAULT_MAX_BARS = 2_400;
const MINUTE_MS = 60_000;
/** Per-second price samples kept for momentum (5 minutes + 1). */
const MOMENTUM_SAMPLES = 301;
/** Below this fraction of the session, RVOL is too noisy to be meaningful. */
const MIN_SESSION_FRACTION_FOR_RVOL = 0.005;

export interface SymbolStoreOptions {
  maxBars?: number;
  /** Fraction (0–1) of the trading session elapsed at `now` — the RVOL time-of-day baseline. */
  sessionFraction?: (now: number) => number;
  /** Session a trade belongs to; defaults to regular (tests, and feeds without extended hours). */
  sessionOf?: (ts: number) => TradeSession;
}

interface Entry {
  snap: SymbolSnapshot;
  /** Σ price·size for session VWAP. */
  pv: number;
  /** Recent 1-minute bars across all sessions, oldest first. Feeds charts and the indicator engine. */
  bars: Bar[];
  /** Ring buffer of last price sampled once per second (see `sampleMomentum`). */
  samples: Float64Array;
  sampleHead: number;
  sampleCount: number;
}

/**
 * In-memory, per-symbol live state. Hot path: O(1) mutation per tick, no allocation per tick.
 *
 * Throttling contract: every mutation marks the symbol dirty; the broadcaster calls
 * `drainDirty()` on a fixed interval (BROADCAST_INTERVAL_MS) and ships only what changed.
 * So 5,000 ticks/sec on one symbol still produce at most 4 UI updates/sec for it.
 */
export class SymbolStore {
  private readonly entries = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private readonly maxBars: number;
  private readonly sessionFraction: (now: number) => number;
  readonly sessionOf: (ts: number) => TradeSession;

  constructor(opts: SymbolStoreOptions = {}) {
    this.maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
    this.sessionFraction = opts.sessionFraction ?? (() => 1);
    this.sessionOf = opts.sessionOf ?? (() => 'regular');
  }

  /**
   * Extended-hours prints move `last` and the day change but not the regular-session
   * open/high/low/volume/VWAP, which is how HOD, RVOL and VWAP scans expect them.
   * Returns the session the trade was booked into, or null if it was rejected.
   */
  applyTrade(t: Trade): TradeSession | null {
    if (!(t.size > 0) || !(t.price > 0)) return null;
    const session = this.sessionOf(t.timestamp);
    if (session !== 'regular') {
      this.applyExtendedTrade(t, session);
      return session;
    }
    const e = this.entry(t.symbol);
    const s = e.snap;
    s.last = t.price;
    s.regularClose = t.price;
    if (s.open === null) {
      s.open = t.price;
      s.gapPct = pct(s.open, s.prevClose);
    }
    s.high = s.high === null ? t.price : Math.max(s.high, t.price);
    s.low = s.low === null ? t.price : Math.min(s.low, t.price);
    s.volume += t.size;
    e.pv += t.price * t.size;
    s.vwap = e.pv / s.volume;
    s.tradeCount += 1;
    s.lastTradeAt = t.timestamp;
    s.changePct = pct(t.price, s.prevClose);
    s.rvol = this.rvol(s, t.timestamp);
    this.addToBar(e, t, 'regular');
    updateMomentum(e);
    s.updatedAt = Date.now();
    this.dirty.add(t.symbol);
    return 'regular';
  }

  private applyExtendedTrade(t: Trade, session: 'pre' | 'post'): void {
    const e = this.entry(t.symbol);
    const s = e.snap;
    s.last = t.price;
    s.changePct = pct(t.price, s.prevClose);
    if (session === 'pre') {
      s.preVolume += t.size;
      s.preHigh = s.preHigh === null ? t.price : Math.max(s.preHigh, t.price);
      s.preLow = s.preLow === null ? t.price : Math.min(s.preLow, t.price);
      s.preLast = t.price;
      s.preChangePct = pct(t.price, s.prevClose);
    } else {
      s.postVolume += t.size;
      s.postHigh = s.postHigh === null ? t.price : Math.max(s.postHigh, t.price);
      s.postLow = s.postLow === null ? t.price : Math.min(s.postLow, t.price);
      s.postChangePct = pct(t.price, s.regularClose);
    }
    s.tradeCount += 1;
    s.lastTradeAt = t.timestamp;
    this.addToBar(e, t, session);
    updateMomentum(e);
    s.updatedAt = Date.now();
    this.dirty.add(t.symbol);
  }

  /**
   * Records every symbol's last price. Call once per second; feeds the 1m/5m change used by
   * momentum scans. Also refreshes momentum for symbols that haven't traded (e.g. halted).
   */
  sampleMomentum(): void {
    for (const [symbol, e] of this.entries) {
      if (e.snap.last === null) continue;
      e.samples[e.sampleHead] = e.snap.last;
      e.sampleHead = (e.sampleHead + 1) % MOMENTUM_SAMPLES;
      e.sampleCount = Math.min(e.sampleCount + 1, MOMENTUM_SAMPLES);
      const before1 = e.snap.chg1mPct;
      const before5 = e.snap.chg5mPct;
      updateMomentum(e);
      if (e.snap.chg1mPct !== before1 || e.snap.chg5mPct !== before5) this.dirty.add(symbol);
    }
  }

  setHalted(symbol: string, halted: boolean): void {
    const s = this.entry(symbol).snap;
    if (s.halted === halted) return;
    s.halted = halted;
    s.updatedAt = Date.now();
    this.dirty.add(symbol);
  }

  applyQuote(q: Quote): void {
    const s = this.entry(q.symbol).snap;
    s.bid = q.bidPrice;
    s.ask = q.askPrice;
    s.bidSize = q.bidSize;
    s.askSize = q.askSize;
    s.updatedAt = Date.now();
    this.dirty.add(q.symbol);
  }

  private addToBar(e: Entry, t: Trade, session: TradeSession): void {
    const start = Math.floor(t.timestamp / MINUTE_MS) * MINUTE_MS;
    const bar = e.bars[e.bars.length - 1];
    if (bar && bar.timestamp === start) {
      bar.high = Math.max(bar.high, t.price);
      bar.low = Math.min(bar.low, t.price);
      bar.close = t.price;
      bar.volume += t.size;
      bar.tradeCount = (bar.tradeCount ?? 0) + 1;
      return;
    }
    // A late print for an earlier minute is already reflected in the snapshot; don't reopen old bars.
    if (bar && start < bar.timestamp) return;
    e.bars.push({
      symbol: t.symbol,
      open: t.price,
      high: t.price,
      low: t.price,
      close: t.price,
      volume: t.size,
      tradeCount: 1,
      timestamp: start,
      session,
    });
    if (e.bars.length > this.maxBars) e.bars.shift();
  }

  /** Replaces a symbol's bar history (startup backfill). Bars must be sorted oldest first. */
  applyHistory(symbol: string, bars: readonly Bar[]): void {
    const e = this.entry(symbol);
    const newer = e.bars.filter((b) => b.timestamp > (bars[bars.length - 1]?.timestamp ?? -Infinity));
    e.bars = [...bars, ...newer].slice(-this.maxBars);
  }

  /** The bar being built for the current minute (or the most recent one). */
  lastBar(symbol: string): Readonly<Bar> | undefined {
    const bars = this.entries.get(symbol)?.bars;
    return bars?.[bars.length - 1];
  }

  /** Inserts a provider bar, or replaces ours for the same minute; the provider's is authoritative. */
  applyBar(b: Bar): void {
    b = b.session ? b : { ...b, session: this.sessionOf(b.timestamp) };
    const bars = this.entry(b.symbol).bars;
    const last = bars[bars.length - 1];
    if (last && last.timestamp === b.timestamp) {
      bars[bars.length - 1] = b;
    } else if (!last || b.timestamp > last.timestamp) {
      bars.push(b);
      if (bars.length > this.maxBars) bars.shift();
    }
  }

  applyReference(r: ReferenceData): void {
    const s = this.entry(r.symbol).snap;
    s.name = r.name ?? s.name;
    s.sector = r.sector ?? s.sector;
    s.floatShares = r.floatShares ?? s.floatShares;
    s.marketCap = r.marketCap ?? s.marketCap;
    s.shortInterestPct = r.shortInterestPct ?? s.shortInterestPct;
    s.avgVolume = r.avgVolume ?? s.avgVolume;
    s.rvol = this.rvol(s, Date.now());
    this.dirty.add(r.symbol);
  }

  /** Replaces today's session state with a snapshot (startup / reconnect bootstrap). */
  applySeed(seed: SessionSeed): void {
    const e = this.entry(seed.symbol);
    const s = e.snap;
    s.prevClose = seed.prevClose;
    s.open = seed.open;
    s.high = seed.high;
    s.low = seed.low;
    s.last = seed.last;
    s.volume = seed.volume;
    s.vwap = seed.vwap;
    s.tradeCount = seed.tradeCount ?? s.tradeCount;
    e.pv = (seed.vwap ?? 0) * seed.volume;
    s.gapPct = pct(seed.open, seed.prevClose);
    s.changePct = pct(seed.last, seed.prevClose);
    s.regularClose = seed.close ?? (seed.open !== null ? seed.last : null);
    if (seed.pre) {
      s.preVolume = seed.pre.volume;
      s.preHigh = seed.pre.high;
      s.preLow = seed.pre.low;
      s.preLast = seed.pre.last;
      s.preChangePct = pct(seed.pre.last, seed.prevClose);
    }
    if (seed.post) {
      s.postVolume = seed.post.volume;
      s.postHigh = seed.post.high;
      s.postLow = seed.post.low;
      s.postChangePct = pct(seed.post.last, s.regularClose);
    }
    s.rvol = this.rvol(s, Date.now());
    s.updatedAt = Date.now();
    this.dirty.add(seed.symbol);
  }

  setPrevClose(symbol: string, prevClose: number): void {
    const s = this.entry(symbol).snap;
    s.prevClose = prevClose;
    s.changePct = pct(s.last, prevClose);
    s.gapPct = pct(s.open, prevClose);
    s.preChangePct = pct(s.preLast, prevClose);
    this.dirty.add(symbol);
  }

  get(symbol: string): Readonly<SymbolSnapshot> | undefined {
    return this.entries.get(symbol)?.snap;
  }

  getBars(symbol: string): readonly Bar[] {
    return this.entries.get(symbol)?.bars ?? [];
  }

  all(): Readonly<SymbolSnapshot>[] {
    return [...this.entries.values()].map((e) => e.snap);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns copies of all snapshots changed since the last drain, and clears the dirty set. */
  drainDirty(): SymbolSnapshot[] {
    const out: SymbolSnapshot[] = [];
    for (const symbol of this.dirty) {
      const e = this.entries.get(symbol);
      if (e) out.push({ ...e.snap });
    }
    this.dirty.clear();
    return out;
  }

  /** Clears intraday accumulators at the start of a new session; keeps bars, reference data and prevClose. */
  resetSession(): void {
    for (const [symbol, e] of this.entries) {
      const prev = e.snap;
      e.snap = {
        ...emptySnapshot(symbol),
        name: prev.name,
        sector: prev.sector,
        floatShares: prev.floatShares,
        marketCap: prev.marketCap,
        shortInterestPct: prev.shortInterestPct,
        avgVolume: prev.avgVolume,
        prevClose: prev.last ?? prev.prevClose,
      };
      e.pv = 0;
      e.sampleCount = 0;
      this.dirty.add(symbol);
    }
  }

  private rvol(s: SymbolSnapshot, now: number): number | null {
    if (!s.avgVolume) return null;
    const fraction = this.sessionFraction(now);
    if (fraction < MIN_SESSION_FRACTION_FOR_RVOL) return null;
    return s.volume / (s.avgVolume * fraction);
  }

  private entry(symbol: string): Entry {
    let e = this.entries.get(symbol);
    if (!e) {
      e = {
        snap: emptySnapshot(symbol),
        pv: 0,
        bars: [],
        samples: new Float64Array(MOMENTUM_SAMPLES),
        sampleHead: 0,
        sampleCount: 0,
      };
      this.entries.set(symbol, e);
    }
    return e;
  }
}

function pct(value: number | null, base: number | null): number | null {
  return value !== null && base ? ((value - base) / base) * 100 : null;
}

/** Price sampled `seconds` ago, or the oldest sample if history is shorter. */
function priceAgo(e: Entry, seconds: number): number | null {
  if (e.sampleCount === 0) return null;
  const back = Math.min(seconds, e.sampleCount - 1);
  return e.samples[(e.sampleHead - 1 - back + 2 * MOMENTUM_SAMPLES) % MOMENTUM_SAMPLES]!;
}

function updateMomentum(e: Entry): void {
  e.snap.chg1mPct = pct(e.snap.last, priceAgo(e, 60));
  e.snap.chg5mPct = pct(e.snap.last, priceAgo(e, 300));
}

function emptySnapshot(symbol: string): SymbolSnapshot {
  return {
    symbol,
    name: null,
    sector: null,
    last: null,
    bid: null,
    ask: null,
    bidSize: 0,
    askSize: 0,
    open: null,
    high: null,
    low: null,
    volume: 0,
    vwap: null,
    tradeCount: 0,
    prevClose: null,
    changePct: null,
    gapPct: null,
    rvol: null,
    floatShares: null,
    marketCap: null,
    shortInterestPct: null,
    avgVolume: null,
    chg1mPct: null,
    chg5mPct: null,
    halted: false,
    preVolume: 0,
    preHigh: null,
    preLow: null,
    preLast: null,
    preChangePct: null,
    regularClose: null,
    postVolume: 0,
    postHigh: null,
    postLow: null,
    postChangePct: null,
    lastTradeAt: null,
    updatedAt: Date.now(),
  };
}
