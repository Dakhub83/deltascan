import { describe, expect, it } from 'vitest';
import type { Indicators, SymbolSnapshot } from '@deltascan/shared';
import { indicatorLabel, minutesSinceCross, passesIndicators } from './indicatorFilter';

const NOW = Date.parse('2026-10-30T14:30:00Z');
const snap = (indicators: Partial<Indicators> | null, rvol: number | null = 3) =>
  ({ symbol: 'RUN', rvol, indicators: indicators && { rsi14: 50, ema9: 1, ema20: 1, emaCross: null, ...indicators } }) as SymbolSnapshot;

describe('indicator filter', () => {
  it('passes everything when nothing is set', () => {
    expect(passesIndicators(snap(null), undefined, NOW)).toBe(true);
    expect(passesIndicators(snap(null), {}, NOW)).toBe(true);
  });

  it('bounds RSI on either side and drops symbols with no RSI yet', () => {
    expect(passesIndicators(snap({ rsi14: 82 }), { rsiMin: 80 }, NOW)).toBe(true);
    expect(passesIndicators(snap({ rsi14: 75 }), { rsiMin: 80 }, NOW)).toBe(false);
    expect(passesIndicators(snap({ rsi14: 25 }), { rsiMax: 30 }, NOW)).toBe(true);
    expect(passesIndicators(snap({ rsi14: null }), { rsiMax: 30 }, NOW)).toBe(false);
    expect(passesIndicators(snap(null), { rsiMin: 0 }, NOW)).toBe(false);
  });

  it('matches the EMA cross direction, optionally within N minutes of the crossing bar closing', () => {
    const crossedAt = NOW - 6 * 60_000; // bar started 6 min ago, closed 5 min ago
    const bear = snap({ emaCross: { dir: 'bear', at: crossedAt } });
    expect(minutesSinceCross(bear, NOW)).toBe(5);
    expect(passesIndicators(bear, { cross: 'bear' }, NOW)).toBe(true);
    expect(passesIndicators(bear, { cross: 'bull' }, NOW)).toBe(false);
    expect(passesIndicators(bear, { cross: 'bear', crossWithinMin: 5 }, NOW)).toBe(true);
    expect(passesIndicators(bear, { cross: 'bear', crossWithinMin: 4 }, NOW)).toBe(false);
    expect(passesIndicators(snap({ emaCross: null }), { cross: 'bear' }, NOW)).toBe(false);
  });

  it('filters on a volume spike', () => {
    expect(passesIndicators(snap(null, 5), { minRvol: 3 }, NOW)).toBe(true);
    expect(passesIndicators(snap(null, 2), { minRvol: 3 }, NOW)).toBe(false);
    expect(passesIndicators(snap(null, null), { minRvol: 3 }, NOW)).toBe(false);
  });

  it('labels the toolbar button', () => {
    expect(indicatorLabel(undefined)).toBe('Indicators');
    expect(indicatorLabel({ rsiMin: 80, cross: 'bear', crossWithinMin: 15, minRvol: 2 })).toBe('RSI ≥ 80 · EMA ▼ 15m · RVOL ≥ 2×');
  });
});
