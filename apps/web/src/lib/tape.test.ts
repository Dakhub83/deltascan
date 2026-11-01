import { describe, expect, it } from 'vitest';
import type { Bar, SymbolSnapshot } from '@deltascan/shared';
import { fmtMultiple, readTape } from './tape';

const NOW = Date.parse('2026-10-26T15:00:00Z');
const bar = (minutesAgo: number, o: number, h: number, l: number, c: number, volume = 1_000): Bar => ({
  symbol: 'RUN',
  open: o,
  high: h,
  low: l,
  close: c,
  volume,
  timestamp: NOW - minutesAgo * 60_000,
});
const snap = (over: Partial<SymbolSnapshot> = {}) =>
  ({ symbol: 'RUN', last: 1, high: 1, vwap: 0.9, chg5mPct: 2, avgVolume: 390_000, halted: false, fade: null, ...over }) as SymbolSnapshot;

describe('readTape', () => {
  it('reads buyers in control when bars close near their highs on volume', () => {
    const bars = Array.from({ length: 15 }, (_, i) => bar(15 - i, 1, 1.1, 0.9, 1.09));
    expect(readTape(bars, snap(), NOW).control).toEqual({ score: 95, side: 'buyers' });
  });

  it('reads sellers when closes sit at the lows', () => {
    const bars = Array.from({ length: 15 }, (_, i) => bar(15 - i, 1, 1.1, 0.9, 0.91));
    expect(readTape(bars, snap(), NOW).control?.side).toBe('sellers');
  });

  it('builds the 60-minute trend and ignores older bars', () => {
    const bars = [bar(90, 5, 5, 5, 5), ...Array.from({ length: 60 }, (_, i) => bar(60 - i, 1 + i / 100, 1.1, 0.9, 1 + (i + 1) / 100))];
    const { trend } = readTape(bars, snap(), NOW);
    expect(trend.closes).toHaveLength(60);
    expect(trend.changePct).toBeCloseTo(60);
    expect(trend.volumes).toHaveLength(6);
    expect(trend.volumes.every((v) => v.value === 10_000 && v.up)).toBe(true);
  });

  it('flags expanding volume and a run through the high with the volume multiple', () => {
    const quiet = Array.from({ length: 15 }, (_, i) => bar(20 - i, 1, 1.01, 0.99, 1, 1_000));
    const loud = Array.from({ length: 5 }, (_, i) => bar(5 - i, 1, 1.01, 0.99, 1, 60_000));
    const tape = readTape([...quiet, ...loud], snap({ last: 1, high: 1 }), NOW);
    expect(tape.volume).toBe('expanding');
    expect(tape.volMultiple).toBe(60); // 60,000 vs 1,000 a minute normally
    expect(tape.status).toEqual({ tone: 'up', text: '▲ RUNNING through $1.00 · 50×+ vol' });
  });

  it('reports a confirmed rejection and VWAP position', () => {
    const fade = { stage: 'confirmation', since: NOW, high: 1.4, highAt: NOW, rejectionHigh: 1.4, rejectionLow: 1.2, confirmLevel: 1.2, lowerHigh: null, vwapBroken: false, backsideStop: null, vwapTest: false } as const;
    expect(readTape([], snap({ last: 1.1, high: 1.4, chg5mPct: -3, fade }), NOW).status?.text).toBe('▼ REJECTED at $1.40');
    expect(readTape([], snap({ last: 0.8, high: 1.4, chg5mPct: 0 }), NOW).status).toEqual({ tone: 'down', text: 'Below VWAP $0.9000' });
  });

  it('formats volume multiples', () => {
    expect([fmtMultiple(3.24), fmtMultiple(12.6), fmtMultiple(75)]).toEqual(['3.2×', '13×', '50×+']);
  });
});
