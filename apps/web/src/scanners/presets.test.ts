import { describe, expect, it } from 'vitest';
import type { SymbolSnapshot } from '@deltascan/shared';
import { PRESETS_BY_ID } from './presets';
import { derived } from './columns';

const snap = (over: Partial<SymbolSnapshot>): SymbolSnapshot =>
  ({
    symbol: 'RUN',
    last: 10,
    open: 10,
    high: 10,
    low: 10,
    prevClose: 10,
    changePct: 0,
    rvol: 1,
    chg1mPct: 0,
    chg5mPct: 0,
    halted: false,
    ...over,
  }) as SymbolSnapshot;

const passes = (id: string, s: SymbolSnapshot) => PRESETS_BY_ID.get(id)!.filter(s);

describe('bullish scanners', () => {
  it('New Highs on 2× RV: at the high on heavy volume', () => {
    expect(passes('new-highs-rvol', snap({ last: 10, high: 10.04, rvol: 2.5, changePct: 8 }))).toBe(true);
    expect(passes('new-highs-rvol', snap({ last: 10, high: 10.04, rvol: 1.5, changePct: 8 }))).toBe(false);
    expect(passes('new-highs-rvol', snap({ last: 10, high: 10.2, rvol: 3, changePct: 8 }))).toBe(false); // 2% under the high
    expect(passes('new-highs-rvol', snap({ last: 10, high: 10, rvol: 3, changePct: 8, halted: true }))).toBe(false);
  });

  it('Up 50¢ in 5 Min works from the 5-minute % change', () => {
    // 5.50 now, +10% over 5 min → it was 5.00: up 50¢.
    expect(derived.chg5mUsd(snap({ last: 5.5, chg5mPct: 10 }))).toBeCloseTo(0.5, 6);
    expect(passes('up-50c-5m', snap({ last: 5.5, chg5mPct: 10.2 }))).toBe(true);
    expect(passes('up-50c-5m', snap({ last: 5.5, chg5mPct: 8 }))).toBe(false);
    expect(passes('up-50c-5m', snap({ last: 200, chg5mPct: 0.3 }))).toBe(true); // 60¢ on a $200 stock
  });

  it('Under $20 Moving Up Fast needs the price band, a 5-minute run and a rising last minute', () => {
    expect(passes('under-20-fast', snap({ last: 4, chg5mPct: 5, chg1mPct: 0.5 }))).toBe(true);
    expect(passes('under-20-fast', snap({ last: 24, chg5mPct: 5, chg1mPct: 0.5 }))).toBe(false);
    expect(passes('under-20-fast', snap({ last: 0.8, chg5mPct: 5, chg1mPct: 0.5 }))).toBe(false);
    expect(passes('under-20-fast', snap({ last: 4, chg5mPct: 5, chg1mPct: -0.2 }))).toBe(false); // already rolling over
  });

  it('Turbo Breaks Up: a one-minute burst at the high on volume', () => {
    expect(passes('turbo-breaks-up', snap({ last: 3, high: 3.01, chg1mPct: 4, rvol: 3 }))).toBe(true);
    expect(passes('turbo-breaks-up', snap({ last: 3, high: 3.2, chg1mPct: 4, rvol: 3 }))).toBe(false);
    expect(passes('turbo-breaks-up', snap({ last: 3, high: 3.01, chg1mPct: 1, rvol: 3 }))).toBe(false);
  });

  it('Rallying off the Bottom: a real selloff, then a bounce that is still well under the high', () => {
    const base = { open: 10, prevClose: 10.2, high: 10.3, low: 9, chg5mPct: 1 };
    expect(passes('rallying-off-bottom', snap({ ...base, last: 9.5 }))).toBe(true); // +5.6% off a 10% drop
    expect(passes('rallying-off-bottom', snap({ ...base, last: 9.1 }))).toBe(false); // barely off the low
    expect(passes('rallying-off-bottom', snap({ ...base, last: 10.25 }))).toBe(false); // back at the high
    expect(passes('rallying-off-bottom', snap({ ...base, low: 9.9, last: 10.21 }))).toBe(false); // never really sold off
    expect(passes('rallying-off-bottom', snap({ ...base, last: 9.5, chg5mPct: -0.5 }))).toBe(false);
  });
});
