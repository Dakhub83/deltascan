import { describe, expect, it } from 'vitest';
import type { Bar } from '@deltascan/shared';
import { computeIndicators, emaSeries, IndicatorEngine, rsi } from '../src/scanner/indicators';

const T0 = Date.parse('2026-10-30T14:00:00Z');
const bars = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ symbol: 'RUN', open: c, high: c, low: c, close: c, volume: 100, timestamp: T0 + i * 60_000 }));

describe('indicators', () => {
  it("matches Wilder's RSI on the classic worked example", () => {
    // StockCharts' RSI table: 70.53, then 66.32, 66.55, 69.41. Its prices are shown rounded to
    // cents but the RSI came from the unrounded ones, hence the 0.1 tolerance.
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const near = (v: number | null, expected: number) => expect(Math.abs(v! - expected)).toBeLessThan(0.1);
    near(rsi(closes), 70.53);
    near(rsi([...closes, 46.0]), 66.32);
    near(rsi([...closes, 46.0, 46.03]), 66.55);
    near(rsi([...closes, 46.0, 46.03, 46.41]), 69.41);
    expect(rsi(closes.slice(0, 14))).toBeNull();
    expect(rsi(Array.from({ length: 20 }, (_, i) => 10 + i))).toBe(100);
  });

  it('seeds the EMA with the simple average, then smooths', () => {
    expect(emaSeries([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]); // 4·0.5 + 2·0.5
  });

  it('finds the latest EMA 9 / 20 cross', () => {
    const up = Array.from({ length: 40 }, (_, i) => 10 + i * 0.1); // rising: 9 above 20
    const down = Array.from({ length: 15 }, (_, i) => 13.9 - (i + 1) * 0.4); // sharp drop: 9 crosses under
    const ind = computeIndicators(bars([...up, ...down]))!;
    expect(ind.emaCross?.dir).toBe('bear');
    expect(ind.ema9).toBeLessThan(ind.ema20);
    // The cross happened inside the drop.
    expect(ind.emaCross!.at).toBeGreaterThan(T0 + 39 * 60_000);
    expect(computeIndicators(bars(up))!.emaCross).toBeNull(); // never crossed
    expect(computeIndicators(bars(up.slice(0, 19)))).toBeNull();
  });

  it('leaves out the bar still forming and recomputes only when one completes', () => {
    const engine = new IndicatorEngine();
    const list = bars(Array.from({ length: 30 }, (_, i) => 10 + i * 0.1));
    const first = engine.evaluate('RUN', list);
    expect(first).toEqual(computeIndicators(list.slice(0, 29)));
    // The forming bar spikes: nothing changes until it completes.
    const forming = [...list.slice(0, 29), { ...list[29]!, close: 50 }];
    expect(engine.evaluate('RUN', forming)).toBe(first);
    const next = [...forming, { ...list[29]!, timestamp: list[29]!.timestamp + 60_000 }];
    expect(engine.evaluate('RUN', next)!.ema9).toBeGreaterThan(first!.ema9);
  });
});
