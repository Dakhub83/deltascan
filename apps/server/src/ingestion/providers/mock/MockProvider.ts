import type { Bar, SessionSeed, TradeSession } from '@deltascan/shared';
import type { Logger } from '../../../lib/logger';
import { MarketDataProvider } from '../MarketDataProvider';
import { MOCK_UNIVERSE, type MockProfile, type MockSymbol } from './universe';

export interface MockProviderOptions {
  ticksPerSecond: number;
  /** Simulated session progress (0–1) at startup; seeds are sized to match. */
  startFraction: number;
  /** Session to simulate. Pre-market and after hours trade thinner and have no LULD halts. */
  session: TradeSession;
  /** Length of a simulated LULD pause (real ones are 300 s; shorter is handier for UI work). */
  haltSeconds: number;
  logger: Logger;
}

type Range = readonly [number, number];

interface ProfileSpec {
  price: Range;
  /** Per-trade volatility as a fraction of price. */
  vol: number;
  float: Range | null;
  avgVolume: Range;
  shortInterest: Range;
  /** Relative share of the tick stream. */
  weight: number;
  spreadBps: number;
  /** Chance the symbol is "in play" today (gapping, high RVOL). */
  inPlayChance: number;
  inPlayGap: Range;
  burstChance: number;
}

const PROFILES: Record<MockProfile, ProfileSpec> = {
  etf: { price: [200, 560], vol: 0.00015, float: null, avgVolume: [30e6, 80e6], shortInterest: [0, 0], weight: 3, spreadBps: 1, inPlayChance: 0, inPlayGap: [0, 0], burstChance: 0.0003 },
  large: { price: [40, 600], vol: 0.0004, float: [8e8, 1.5e10], avgVolume: [8e6, 60e6], shortInterest: [0.5, 4], weight: 2, spreadBps: 2, inPlayChance: 0.12, inPlayGap: [2, 9], burstChance: 0.001 },
  mid: { price: [3, 90], vol: 0.0008, float: [1e8, 1.8e9], avgVolume: [8e6, 70e6], shortInterest: [3, 22], weight: 1.5, spreadBps: 5, inPlayChance: 0.2, inPlayGap: [4, 18], burstChance: 0.0015 },
  micro: { price: [0.8, 14], vol: 0.0022, float: [1e6, 2.5e7], avgVolume: [4e5, 8e6], shortInterest: [5, 40], weight: 1, spreadBps: 20, inPlayChance: 0.4, inPlayGap: [8, 60], burstChance: 0.004 },
};

const TICK_INTERVAL_MS = 50;
const SESSION_SECONDS = 6.5 * 3600;
const MINUTE_MS = 60_000;
/** Session lengths in minutes, for chart history. */
const SESSION_MINUTES: Record<TradeSession, number> = { pre: 330, regular: 390, post: 240 };
/** Minutes between the previous day's close and today's pre-market. */
const OVERNIGHT_MINUTES = 8 * 60;
const BLOCK_CHANCE = 0.0005;
/** Extended-hours prints are a fraction of regular-session size. */
const EXTENDED_SIZE = 0.12;
/** Chance a symbol reports earnings after the close and moves hard in the post session. */
const EARNINGS_CHANCE = 0.15;
/** Pull toward the anchor per trade, in units of the profile's volatility. */
const MEAN_REVERSION = 1;

// Halts: a burst that moves a small/mid cap this far triggers an LULD pause.
const HALT_TRIGGER_MOVE = 0.1;
const MAX_ACTIVE_HALTS = 3;
const HALT_COOLDOWN_MS = 20 * 60_000;
/** Market-wide spacing between new halts, so the Halts window gets a steady trickle, not a flood. */
const MIN_HALT_SPACING_MS = 2 * 60_000;
const NEWS_HALT_CHANCE = 0.00002;
/** Quotation-only period before re-opening. */
const QUOTING_LEAD_MS = 15_000;

interface SimHalt {
  until: number;
  quotingAt: number;
  quoting: boolean;
  reasonCode: string;
  dir: 1 | -1;
}

interface Sim {
  meta: MockSymbol;
  spec: ProfileSpec;
  price: number;
  /** Level the price reverts toward, so bursts and reopen gaps fade instead of compounding. */
  anchor: number;
  inPlay: boolean;
  avgVolume: number;
  avgTradeSize: number;
  /** Remaining trades of an active momentum burst. */
  burst: number;
  burstDir: 1 | -1;
  burstStartPrice: number;
  halt: SimHalt | null;
  haltCooldownUntil: number;
}

/**
 * Synthetic market for building the scanner/UI without API keys or market hours.
 * Seeds each symbol with a plausible mid-session state, then streams quotes/trades with
 * momentum bursts, volume surges and block prints so every scanner and alert gets exercised.
 */
export class MockProvider extends MarketDataProvider {
  readonly name = 'mock';
  private readonly sims = new Map<string, Sim>();
  private timer: NodeJS.Timeout | null = null;
  private seededHalts = false;
  private lastHaltAt = 0;

  constructor(private readonly opts: MockProviderOptions) {
    super();
  }

  static get defaultSymbols(): string[] {
    return MOCK_UNIVERSE.map((m) => m.symbol);
  }

  start(): void {
    if (this.timer) return;
    this.setStatus('authenticated', 'simulated feed');
    this.opts.logger.info({ ticksPerSecond: this.opts.ticksPerSecond, symbols: this.sims.size }, 'mock provider started');
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus('stopped');
  }

  protected onSubscribe(symbols: string[]): void {
    for (const symbol of symbols) {
      const meta = MOCK_UNIVERSE.find((m) => m.symbol === symbol) ?? {
        symbol,
        name: symbol,
        sector: 'Other',
        profile: 'mid' as const,
      };
      this.seedSymbol(meta);
    }
    this.resizeTrades();
    if (!this.seededHalts && this.opts.session === 'regular') {
      this.seededHalts = true;
      this.seedHalts();
    }
  }

  protected onUnsubscribe(symbols: string[]): void {
    symbols.forEach((s) => this.sims.delete(s));
    this.resizeTrades();
  }

  private seedSymbol(meta: MockSymbol): void {
    const spec = PROFILES[meta.profile];
    const prevClose = round(logUniform(...spec.price));
    const inPlay = Math.random() < spec.inPlayChance;
    const gapPct = inPlay
      ? (Math.random() < 0.75 ? 1 : -1) * uniform(...spec.inPlayGap)
      : (Math.random() - 0.5) * 2 * spec.vol * 2000;
    const avgVolume = Math.round(logUniform(...spec.avgVolume));
    const floatShares = spec.float ? Math.round(logUniform(...spec.float)) : undefined;
    const seed = this.seedFor(meta.symbol, spec, prevClose, gapPct, inPlay, avgVolume, meta.profile === 'micro');
    const earnings = seed.post !== undefined && Math.abs(seed.post.last / seed.close! - 1) >= 0.03;

    this.sims.set(meta.symbol, {
      meta,
      spec,
      price: seed.last,
      anchor: seed.last,
      inPlay: inPlay || earnings,
      avgVolume,
      avgTradeSize: 0,
      burst: 0,
      burstDir: 1,
      burstStartPrice: seed.last,
      halt: null,
      haltCooldownUntil: 0,
    });

    this.emit('reference', {
      symbol: meta.symbol,
      name: meta.name,
      sector: meta.sector,
      floatShares,
      marketCap: floatShares ? Math.round(floatShares * prevClose * uniform(1.05, 1.6)) : undefined,
      shortInterestPct: spec.float ? round(uniform(...spec.shortInterest)) : undefined,
      avgVolume,
    });
    this.emit('seed', seed);
    this.emit('history', meta.symbol, this.historyFor(meta.symbol, spec, seed, avgVolume));
  }

  /**
   * 1-minute bars for the previous regular session and today so far, ending the minute
   * before now. Paths pass through the seeded open/high/low/last so charts match the snapshot.
   */
  private historyFor(symbol: string, spec: ProfileSpec, seed: SessionSeed, avgVolume: number): Bar[] {
    const { session, startFraction } = this.opts;
    const elapsed = (s: TradeSession) => Math.max(1, Math.round(SESSION_MINUTES[s] * startFraction));
    const segments: { session: TradeSession; minutes: number; from: number; to: number; high: number; low: number; volume: number }[] = [];

    const pre = seed.pre!;
    segments.push({ session: 'pre', minutes: session === 'pre' ? elapsed('pre') : SESSION_MINUTES.pre, from: seed.prevClose, to: pre.last, high: pre.high, low: pre.low, volume: pre.volume });
    if (session !== 'pre') {
      const to = seed.close ?? seed.last;
      segments.push({ session: 'regular', minutes: session === 'regular' ? elapsed('regular') : SESSION_MINUTES.regular, from: seed.open!, to, high: seed.high!, low: seed.low!, volume: seed.volume });
    }
    if (seed.post) {
      segments.push({ session: 'post', minutes: elapsed('post'), from: seed.close!, to: seed.post.last, high: seed.post.high, low: seed.post.low, volume: seed.post.volume });
    }

    const todayMinutes = segments.reduce((n, s) => n + s.minutes, 0);
    const now = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    let t = now - todayMinutes * MINUTE_MS;

    const prevOpen = seed.prevClose * (1 + (Math.random() - 0.5) * spec.vol * 40);
    const prevDay = {
      session: 'regular' as const,
      minutes: SESSION_MINUTES.regular,
      from: prevOpen,
      to: seed.prevClose,
      high: Math.max(prevOpen, seed.prevClose) * (1 + Math.random() * spec.vol * 15),
      low: Math.min(prevOpen, seed.prevClose) * (1 - Math.random() * spec.vol * 15),
      volume: avgVolume * uniform(0.6, 1.4),
    };
    const prevStart = t - (OVERNIGHT_MINUTES + prevDay.minutes) * MINUTE_MS;

    const bars = pathBars(symbol, prevDay, prevStart);
    for (const seg of segments) {
      bars.push(...pathBars(symbol, seg, t));
      t += seg.minutes * MINUTE_MS;
    }
    return bars;
  }

  /** Today's state so far for the simulated session. */
  private seedFor(
    symbol: string,
    spec: ProfileSpec,
    prevClose: number,
    gapPct: number,
    inPlay: boolean,
    avgVolume: number,
    micro: boolean,
  ): SessionSeed {
    const extreme = (a: number, b: number, dir: 1 | -1) => (dir > 0 ? Math.max(a, b) : Math.min(a, b)) * (1 + dir * Math.random() * spec.vol * 15);
    const preLast = prevClose * (1 + gapPct / 100);
    const pre = {
      volume: Math.round(avgVolume * (inPlay ? uniform(0.02, 0.25) : uniform(0.001, 0.01))),
      high: round(extreme(prevClose, preLast, 1)),
      low: round(extreme(prevClose, preLast, -1)),
      last: round(preLast),
    };
    if (this.opts.session === 'pre') {
      return { symbol, prevClose, open: null, high: null, low: null, vwap: null, volume: 0, last: pre.last, pre };
    }

    const open = preLast;
    const dayMove = (Math.random() - 0.4) * (inPlay ? 0.2 : 0.025);
    const last = open * (1 + dayMove);
    const high = Math.max(open, last) * (1 + Math.random() * spec.vol * 15);
    const low = Math.min(open, last) * (1 - Math.random() * spec.vol * 15);
    const vwap = (open + last + high + low) / 4;
    const rvolTarget = inPlay ? uniform(2, micro ? 20 : 8) : uniform(0.5, 1.6);
    const fraction = this.opts.session === 'post' ? 1 : this.opts.startFraction;
    const regular = {
      symbol,
      prevClose,
      open: round(open),
      high: round(high),
      low: round(low),
      vwap,
      volume: Math.round(avgVolume * fraction * rvolTarget),
      last: round(last),
      pre,
    };
    if (this.opts.session === 'regular') return regular;

    const earnings = Math.random() < EARNINGS_CHANCE;
    const postMove = earnings ? (Math.random() < 0.6 ? 1 : -1) * uniform(0.03, 0.18) : (Math.random() - 0.5) * 0.012;
    const postLast = last * (1 + postMove);
    const post = {
      volume: Math.round(avgVolume * (earnings ? uniform(0.03, 0.2) : uniform(0.002, 0.01))),
      high: round(extreme(last, postLast, 1)),
      low: round(extreme(last, postLast, -1)),
      last: round(postLast),
    };
    return { ...regular, close: round(last), last: post.last, post };
  }

  /** Size trades so each symbol's base tick rate reproduces its average daily volume (RVOL ≈ 1). */
  private resizeTrades(): void {
    const totalWeight = [...this.sims.values()].reduce((sum, s) => sum + s.spec.weight, 0);
    for (const sim of this.sims.values()) {
      const tradesPerDay = this.opts.ticksPerSecond * (sim.spec.weight / totalWeight) * SESSION_SECONDS;
      sim.avgTradeSize = tradesPerDay > 0 ? sim.avgVolume / tradesPerDay : 100;
    }
  }

  /** Today's earlier halts (already resumed) plus one in progress, so the Halts window isn't empty at start. */
  private seedHalts(): void {
    const now = Date.now();
    const pauseMs = this.opts.haltSeconds * 1000;
    const candidates = [...this.sims.values()].filter((s) => s.meta.profile === 'micro' && s.inPlay);

    candidates.slice(0, 3).forEach((sim, i) => {
      const haltedAt = now - (25 + i * 35) * 60_000;
      const haltPrice = round(sim.price * uniform(0.82, 0.95));
      const base = { symbol: sim.meta.symbol, reasonCode: 'LUDP', direction: 'up' as const };
      this.emit('tradingStatus', { ...base, state: 'halted', price: haltPrice, timestamp: haltedAt });
      this.emit('tradingStatus', {
        ...base,
        state: 'resumed',
        price: round(haltPrice * uniform(1.01, 1.12)),
        timestamp: haltedAt + pauseMs,
      });
    });

    const live = candidates[3];
    if (live) this.startHalt(live, now - pauseMs * 0.3, 'LUDP', 1);
  }

  private startHalt(sim: Sim, at: number, reasonCode: string, dir: 1 | -1): void {
    const duration = this.opts.haltSeconds * 1000 * (reasonCode === 'LUDP' ? 1 : uniform(2, 3));
    this.lastHaltAt = Math.max(this.lastHaltAt, at);
    sim.halt = { until: at + duration, quotingAt: at + duration - QUOTING_LEAD_MS, quoting: false, reasonCode, dir };
    sim.burst = 0;
    this.emit('tradingStatus', {
      symbol: sim.meta.symbol,
      state: 'halted',
      reasonCode,
      direction: dir > 0 ? 'up' : 'down',
      price: roundTo(sim.price, sim.price < 1 ? 0.0001 : 0.01),
      timestamp: at,
    });
  }

  private advanceHalt(sim: Sim, now: number): void {
    const halt = sim.halt!;
    const base = { symbol: sim.meta.symbol, reasonCode: halt.reasonCode, timestamp: now };
    if (!halt.quoting && now >= halt.quotingAt) {
      halt.quoting = true;
      this.emit('tradingStatus', { ...base, state: 'quoting' });
    }
    if (now < halt.until) return;

    // Re-open gaps, usually continuing the move that caused the halt.
    const dir: 1 | -1 = Math.random() < 0.65 ? halt.dir : halt.dir === 1 ? -1 : 1;
    sim.price *= 1 + dir * uniform(0.01, 0.15);
    sim.halt = null;
    sim.haltCooldownUntil = now + HALT_COOLDOWN_MS;
    sim.burst = 60 + Math.floor(Math.random() * 120);
    sim.burstDir = dir;
    sim.burstStartPrice = sim.price;
    this.emit('tradingStatus', { ...base, state: 'resumed' });
  }

  private tick(): void {
    if (!this.sims.size) return;
    const now = Date.now();
    const sims = [...this.sims.values()];
    for (const sim of sims) if (sim.halt) this.advanceHalt(sim, now);

    const weights = sims.map((s) =>
      s.halt ? 0 : s.spec.weight * (s.inPlay ? 3 : 1) * (s.burst > 0 ? 4 : 1),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const picks = Math.max(1, Math.round((this.opts.ticksPerSecond * TICK_INTERVAL_MS) / 1000));

    for (let i = 0; i < picks; i++) {
      let r = Math.random() * total;
      let idx = 0;
      while (idx < sims.length - 1 && (r -= weights[idx]!) > 0) idx++;
      const sim = sims[idx]!;
      if (!sim.halt) this.tradeOnce(sim, now);
    }
  }

  private activeHalts(): number {
    let n = 0;
    for (const s of this.sims.values()) if (s.halt) n++;
    return n;
  }

  private tradeOnce(sim: Sim, now: number): void {
    const { spec, meta } = sim;
    if (sim.burst === 0 && Math.random() < spec.burstChance * (sim.inPlay ? 2 : 1)) {
      sim.burst = 80 + Math.floor(Math.random() * 400);
      sim.burstDir = Math.random() < 0.7 ? 1 : -1;
      sim.burstStartPrice = sim.price;
    }
    const bursting = sim.burst > 0;
    if (bursting) sim.burst--;

    const drift = bursting ? sim.burstDir * spec.vol * 0.5 : 0;
    const reversion = -spec.vol * MEAN_REVERSION * Math.log(sim.price / sim.anchor);
    sim.price = Math.max(0.05, sim.price * (1 + drift + reversion + (Math.random() - 0.5) * 2 * spec.vol));

    const tick = sim.price < 1 ? 0.0001 : 0.01;
    const halfSpread = Math.max(tick, (sim.price * spec.spreadBps) / 20_000);
    const price = roundTo(sim.price, tick);

    this.emit('quote', {
      symbol: meta.symbol,
      bidPrice: roundTo(sim.price - halfSpread, tick),
      bidSize: randInt(1, 30) * 100,
      askPrice: roundTo(sim.price + halfSpread, tick),
      askSize: randInt(1, 30) * 100,
      timestamp: now,
    });

    const sessionSize = this.opts.session === 'regular' ? 1 : EXTENDED_SIZE;
    let size = sim.avgTradeSize * sessionSize * uniform(0.2, 1.8) * (bursting ? 6 : 1);
    if (Math.random() < BLOCK_CHANCE) {
      size = Math.max(10_000, 250_000 / price) * uniform(1, 6);
    }
    size = size >= 100 ? Math.round(size / 100) * 100 : Math.max(1, Math.round(size));

    this.emit('trade', { symbol: meta.symbol, price, size, timestamp: now, exchange: 'SIM' });

    const canHalt =
      this.opts.session === 'regular' &&
      (meta.profile === 'micro' || meta.profile === 'mid') &&
      now >= sim.haltCooldownUntil &&
      now - this.lastHaltAt >= MIN_HALT_SPACING_MS &&
      this.activeHalts() < MAX_ACTIVE_HALTS;
    if (!canHalt) return;
    const burstMove = sim.price / sim.burstStartPrice - 1;
    if (bursting && Math.abs(burstMove) >= HALT_TRIGGER_MOVE) {
      this.startHalt(sim, now, 'LUDP', burstMove > 0 ? 1 : -1);
    } else if (meta.profile === 'micro' && Math.random() < NEWS_HALT_CHANCE) {
      this.startHalt(sim, now, 'T1', Math.random() < 0.6 ? 1 : -1);
    }
  }
}

interface PathSegment {
  session: TradeSession;
  minutes: number;
  from: number;
  to: number;
  high: number;
  low: number;
  volume: number;
}

/**
 * Bars that open at `from`, close at `to` and touch exactly `high` and `low`: a log-price
 * Brownian bridge through those four waypoints, clamped to the range. Volume follows the
 * usual U shape (heavy at the open and close).
 */
function pathBars(symbol: string, seg: PathSegment, start: number): Bar[] {
  const n = Math.max(1, seg.minutes);
  const high = Math.max(seg.high, seg.from, seg.to);
  const low = Math.min(seg.low, seg.from, seg.to);
  const tick = low < 1 ? 0.0001 : 0.01;
  // Extremes stay off the last minute, which must close at `to`.
  const last = Math.max(0, n - 2);
  const hiAt = randInt(0, last);
  let loAt = randInt(0, last);
  if (loAt === hiAt && last > 0) loAt = (hiAt + Math.max(1, Math.floor(n / 2))) % (last + 1);

  const waypoints = [
    { i: -1, p: seg.from },
    { i: hiAt, p: high },
    { i: loAt, p: low },
    { i: n - 1, p: seg.to },
  ].sort((a, b) => a.i - b.i);
  const sigma = Math.log(high / low) / Math.sqrt(n) * 0.6;

  const closes = new Array<number>(n);
  for (let w = 0; w < waypoints.length - 1; w++) {
    const a = waypoints[w]!;
    const b = waypoints[w + 1]!;
    const steps = b.i - a.i;
    if (steps <= 0) continue;
    let walk = 0;
    const walks: number[] = [];
    for (let k = 1; k <= steps; k++) walks.push((walk += gaussian() * sigma));
    for (let k = 1; k <= steps; k++) {
      const frac = k / steps;
      const bridge = walks[k - 1]! - frac * walks[steps - 1]!;
      const logP = Math.log(a.p) + frac * (Math.log(b.p) - Math.log(a.p)) + bridge;
      closes[a.i + k] = Math.min(high, Math.max(low, Math.exp(logP)));
    }
  }

  const weights = Array.from({ length: n }, (_, i) => {
    const x = n === 1 ? 0.5 : i / (n - 1);
    return (1 + 2.5 * (2 * x - 1) ** 2) * uniform(0.5, 1.5);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  return closes.map((close, i) => {
    const open = i === 0 ? seg.from : closes[i - 1]!;
    const wiggle = () => Math.abs(gaussian()) * sigma * 0.5;
    let barHigh = Math.min(high, Math.max(open, close) * (1 + wiggle()));
    let barLow = Math.max(low, Math.min(open, close) * (1 - wiggle()));
    if (i === hiAt) barHigh = high;
    if (i === loAt) barLow = low;
    return {
      symbol,
      open: roundTo(open, tick),
      high: roundTo(barHigh, tick),
      low: roundTo(barLow, tick),
      close: roundTo(close, tick),
      volume: Math.max(100, Math.round((seg.volume * weights[i]!) / totalWeight / 100) * 100),
      timestamp: start + i * MINUTE_MS,
      session: seg.session,
    };
  });
}

/** Standard normal via Box–Muller. */
function gaussian(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

const uniform = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const logUniform = (lo: number, hi: number) => Math.exp(uniform(Math.log(lo), Math.log(hi)));
const round = (n: number) => Math.round(n * 100) / 100;
const roundTo = (n: number, step: number) => Number((Math.round(n / step) * step).toFixed(4));
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
