import { describe, expect, it } from 'vitest';
import type { SymbolSnapshot } from '@deltascan/shared';
import { HaltTracker } from '../src/scanner/HaltTracker';

const snap = (over: Partial<SymbolSnapshot> = {}) =>
  ({ symbol: 'ABC', last: 5, prevClose: 4, chg5mPct: 12, chg1mPct: 6, ...over }) as SymbolSnapshot;

describe('HaltTracker', () => {
  it('records an LULD halt with direction, price and expected resume', () => {
    const tracker = new HaltTracker({ luldPauseMs: 300_000 });
    tracker.onStatus({ symbol: 'ABC', state: 'halted', reasonCode: 'LUDP', timestamp: 1_000 }, snap());

    const [halt] = tracker.drain();
    expect(halt).toMatchObject({
      symbol: 'ABC',
      state: 'halted',
      direction: 'up',
      haltPrice: 5,
      reason: 'Volatility pause (LULD)',
      expectedResumeAt: 301_000,
    });
    expect(halt!.haltChangePct).toBeCloseTo(25);
    expect(tracker.isHalted('ABC')).toBe(true);
  });

  it('completes the halt on resume and takes the first print as the resume price', () => {
    const resumed: string[] = [];
    const tracker = new HaltTracker({ onResume: (h) => resumed.push(h.symbol) });
    tracker.onStatus({ symbol: 'ABC', state: 'halted', reasonCode: 'T1', timestamp: 1_000 }, snap());
    tracker.onStatus({ symbol: 'ABC', state: 'resumed', reasonCode: 'T1', timestamp: 9_000 }, snap());
    tracker.drain();
    tracker.onTrade({ symbol: 'ABC', price: 5.5, size: 100, timestamp: 9_100 });

    const [halt] = tracker.drain();
    expect(halt).toMatchObject({ state: 'resumed', resumedAt: 9_000, resumePrice: 5.5, expectedResumeAt: null, direction: null });
    expect(halt!.resumeGapPct).toBeCloseTo(10);
    expect(resumed).toEqual(['ABC']);
    expect(tracker.isHalted('ABC')).toBe(false);
  });

  it('ignores duplicate halt messages and resumes without a halt', () => {
    const tracker = new HaltTracker();
    tracker.onStatus({ symbol: 'XYZ', state: 'resumed', reasonCode: 'T1', timestamp: 1 }, snap());
    tracker.onStatus({ symbol: 'ABC', state: 'halted', reasonCode: 'LUDP', timestamp: 1 }, snap());
    tracker.onStatus({ symbol: 'ABC', state: 'halted', reasonCode: 'LUDP', timestamp: 2 }, snap());
    expect(tracker.recent()).toHaveLength(1);
  });
});
