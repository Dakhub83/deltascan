import type { Bar, Quote, ReferenceData, SessionSeed, SymbolSnapshot, Trade } from '@scanner/shared';

const DEFAULT_MAX_BARS = 500;
/** Below this fraction of the session, RVOL is too noisy to be meaningful. */
const MIN_SESSION_FRACTION_FOR_RVOL = 0.005;

export interface SymbolStoreOptions {
  maxBars?: number;
  /** Fraction (0–1) of the trading session elapsed at `now` — the RVOL time-of-day baseline. */
  sessionFraction?: (now: number) => number;
}

interface Entry {
  snap: SymbolSnapshot;
  /** Σ price·size for session VWAP. */
  pv: number;
  /** Ring buffer of recent 1-minute bars, oldest first. Feeds the indicator engine. */
  bars: Bar[];
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

  constructor(opts: SymbolStoreOptions = {}) {
    this.maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
    this.sessionFraction = opts.sessionFraction ?? (() => 1);
  }

  applyTrade(t: Trade): void {
    if (!(t.size > 0) || !(t.price > 0)) return;
    const e = this.entry(t.symbol);
    const s = e.snap;
    s.last = t.price;
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
    s.updatedAt = Date.now();
    this.dirty.add(t.symbol);
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

  /** Inserts a bar, or replaces the last bar if it has the same start time (Alpaca "updated bars"). */
  applyBar(b: Bar): void {
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
    e.pv = seed.vwap * seed.volume;
    s.gapPct = pct(seed.open, seed.prevClose);
    s.changePct = pct(seed.last, seed.prevClose);
    s.rvol = this.rvol(s, Date.now());
    s.updatedAt = Date.now();
    this.dirty.add(seed.symbol);
  }

  setPrevClose(symbol: string, prevClose: number): void {
    const s = this.entry(symbol).snap;
    s.prevClose = prevClose;
    s.changePct = pct(s.last, prevClose);
    s.gapPct = pct(s.open, prevClose);
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
      e = { snap: emptySnapshot(symbol), pv: 0, bars: [] };
      this.entries.set(symbol, e);
    }
    return e;
  }
}

function pct(value: number | null, base: number | null): number | null {
  return value !== null && base ? ((value - base) / base) * 100 : null;
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
    lastTradeAt: null,
    updatedAt: Date.now(),
  };
}
