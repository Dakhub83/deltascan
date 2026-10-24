import type { Logger } from '../../../lib/logger';
import { MarketDataProvider } from '../MarketDataProvider';
import { MOCK_UNIVERSE, type MockProfile, type MockSymbol } from './universe';

export interface MockProviderOptions {
  ticksPerSecond: number;
  /** Simulated session progress (0–1) at startup; seeds are sized to match. */
  startFraction: number;
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
const BLOCK_CHANCE = 0.0005;

interface Sim {
  meta: MockSymbol;
  spec: ProfileSpec;
  price: number;
  inPlay: boolean;
  avgVolume: number;
  avgTradeSize: number;
  /** Remaining trades of an active momentum burst. */
  burst: number;
  burstDir: 1 | -1;
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
    const open = prevClose * (1 + gapPct / 100);
    const dayMove = (Math.random() - 0.4) * (inPlay ? 0.2 : 0.025);
    const last = open * (1 + dayMove);
    const high = Math.max(open, last) * (1 + Math.random() * spec.vol * 15);
    const low = Math.min(open, last) * (1 - Math.random() * spec.vol * 15);
    const vwap = (open + last + high + low) / 4;

    const avgVolume = Math.round(logUniform(...spec.avgVolume));
    const rvolTarget = inPlay ? uniform(2, meta.profile === 'micro' ? 20 : 8) : uniform(0.5, 1.6);
    const floatShares = spec.float ? Math.round(logUniform(...spec.float)) : undefined;

    this.sims.set(meta.symbol, {
      meta,
      spec,
      price: last,
      inPlay,
      avgVolume,
      avgTradeSize: 0,
      burst: 0,
      burstDir: 1,
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
    this.emit('seed', {
      symbol: meta.symbol,
      prevClose,
      open: round(open),
      high: round(high),
      low: round(low),
      last: round(last),
      vwap,
      volume: Math.round(avgVolume * this.opts.startFraction * rvolTarget),
    });
  }

  /** Size trades so each symbol's base tick rate reproduces its average daily volume (RVOL ≈ 1). */
  private resizeTrades(): void {
    const totalWeight = [...this.sims.values()].reduce((sum, s) => sum + s.spec.weight, 0);
    for (const sim of this.sims.values()) {
      const tradesPerDay = this.opts.ticksPerSecond * (sim.spec.weight / totalWeight) * SESSION_SECONDS;
      sim.avgTradeSize = tradesPerDay > 0 ? sim.avgVolume / tradesPerDay : 100;
    }
  }

  private tick(): void {
    if (!this.sims.size) return;
    const sims = [...this.sims.values()];
    const weights = sims.map((s) => s.spec.weight * (s.inPlay ? 3 : 1) * (s.burst > 0 ? 4 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const picks = Math.max(1, Math.round((this.opts.ticksPerSecond * TICK_INTERVAL_MS) / 1000));
    const now = Date.now();

    for (let i = 0; i < picks; i++) {
      let r = Math.random() * total;
      let idx = 0;
      while (idx < sims.length - 1 && (r -= weights[idx]!) > 0) idx++;
      this.tradeOnce(sims[idx]!, now);
    }
  }

  private tradeOnce(sim: Sim, now: number): void {
    const { spec, meta } = sim;
    if (sim.burst === 0 && Math.random() < spec.burstChance * (sim.inPlay ? 2 : 1)) {
      sim.burst = 80 + Math.floor(Math.random() * 400);
      sim.burstDir = Math.random() < 0.7 ? 1 : -1;
    }
    const bursting = sim.burst > 0;
    if (bursting) sim.burst--;

    const drift = bursting ? sim.burstDir * spec.vol * 0.5 : 0;
    sim.price = Math.max(0.05, sim.price * (1 + drift + (Math.random() - 0.5) * 2 * spec.vol));

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

    let size = sim.avgTradeSize * uniform(0.2, 1.8) * (bursting ? 6 : 1);
    if (Math.random() < BLOCK_CHANCE) {
      size = Math.max(10_000, 250_000 / price) * uniform(1, 6);
    }
    size = size >= 100 ? Math.round(size / 100) * 100 : Math.max(1, Math.round(size));

    this.emit('trade', { symbol: meta.symbol, price, size, timestamp: now, exchange: 'SIM' });
  }
}

const uniform = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const logUniform = (lo: number, hi: number) => Math.exp(uniform(Math.log(lo), Math.log(hi)));
const round = (n: number) => Math.round(n * 100) / 100;
const roundTo = (n: number, step: number) => Number((Math.round(n / step) * step).toFixed(4));
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
