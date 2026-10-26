import { describe, expect, it } from 'vitest';
import { DEFAULT_SHORT_LIMITS, planShort } from './shortPlan';

const limits = { ...DEFAULT_SHORT_LIMITS, maxRisk: 100, maxShares: 5_000, maxLots: 4 };

describe('planShort', () => {
  it('sizes the first lot by risk: $100 over a $0.20 stop is 500 shares', () => {
    const plan = planShort({ stop: 5.2, entries: [5.0], premarket: false }, limits);
    expect(plan.lots[0]).toMatchObject({ shares: 500, stop: 5.2, totalShares: 500, avgCost: 5 });
    expect(plan.lots[0]!.openRisk).toBeCloseTo(100);
  });

  it('keeps total risk fixed on adds by moving the stop to the last entry + $0.10', () => {
    const plan = planShort({ stop: 5.2, entries: [5.0, 4.8, 4.6], premarket: false }, limits);
    const [l1, l2, l3] = plan.lots;
    // Add 1: stop 4.90 locks $0.10 × 500 = $50 on lot 1, so $150 of budget at $0.10/share.
    expect(l2).toMatchObject({ stop: 4.9, shares: 1_500, totalShares: 2_000 });
    // Add 2: stop 4.70 locks $150 + $300, so $550 of budget, capped at 5,000 shares total.
    expect(l3).toMatchObject({ stop: 4.7, shares: 3_000, totalShares: 5_000 });
    for (const lot of [l1, l2]) expect(lot!.openRisk).toBeCloseTo(100);
    expect(l3!.openRisk).toBeLessThanOrEqual(100);
    expect(plan.warnings.map((w) => w.kind)).toContain('share-cap');
  });

  it('caps a pre-market probe at 100 shares', () => {
    const plan = planShort({ stop: 3.5, entries: [3.0, 2.8], premarket: true }, limits);
    expect(plan.lots[0]!.shares).toBe(100);
    expect(plan.lots[1]!.shares).toBe(0);
    expect(plan.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(['premarket', 'share-cap']));
  });

  it('flags averaging up, too many lots and tight stops', () => {
    const plan = planShort({ stop: 2.03, entries: [2.0, 2.1, 1.9, 1.8, 1.7], premarket: false, spread: 0.02 }, limits);
    const kinds = plan.warnings.map((w) => w.kind);
    expect(kinds).toContain('averaging-up');
    expect(kinds).toContain('too-many-lots');
    expect(kinds.filter((k) => k === 'tight-stop')).toHaveLength(2); // under $0.05 and inside 2× spread
  });

  it('gives DAS hotkey prices off the final average cost', () => {
    const plan = planShort({ stop: 5.2, entries: [5.0, 4.8], premarket: false }, limits);
    // 500 @ 5.00 + 1,500 @ 4.80 → avg 4.85
    expect(plan.hotkeys).toEqual({ coverStop: 4.88, longExit: 4.82 });
  });

  it('rejects a stop below the entry', () => {
    expect(planShort({ stop: 4.9, entries: [5.0], premarket: false }, limits).error).toMatch(/above the first entry/);
  });
});
