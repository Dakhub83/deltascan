import { describe, expect, it } from 'vitest';
import type { Alert, FadeState } from '@deltascan/shared';
import { fadeLevels, signalMarks } from './fadeSignals';

const T = Date.parse('2026-10-29T14:00:00Z');
const MIN = 60_000;

const fade = (over: Partial<FadeState>): FadeState => ({
  stage: 'extension',
  since: T,
  high: 2.72,
  highAt: T,
  rejectionHigh: null,
  rejectionLow: null,
  confirmLevel: null,
  lowerHigh: null,
  ...over,
});

const alert = (type: Alert['type'], minute: number, symbol = 'RUN'): Alert => ({
  id: `${type}${minute}`,
  type,
  symbol,
  price: 2.5,
  detail: '',
  changePct: null,
  timestamp: T + minute * MIN + 800,
});

describe('fadeLevels', () => {
  it('draws only the high while extended, nothing on a bare spike', () => {
    expect(fadeLevels(fade({ stage: 'spike' }))).toEqual([]);
    expect(fadeLevels(fade({}))).toEqual([{ kind: 'hod', price: 2.72, title: 'HOD' }]);
  });

  it('marks risk and the confirmation trigger while rejecting', () => {
    expect(fadeLevels(fade({ stage: 'rejection', rejectionHigh: 2.72, rejectionLow: 2.55 }))).toEqual([
      { kind: 'risk', price: 2.72, title: 'HOD · RISK' },
      { kind: 'trigger', price: 2.55, title: 'CONFIRMS <' },
    ]);
    expect(fadeLevels(fade({ stage: 'rejection', rejectionHigh: 2.7, rejectionLow: 2.55 })).map((l) => l.title)).toEqual(['HOD', 'RISK', 'CONFIRMS <']);
  });

  it('shows the broken level once confirmed', () => {
    const levels = fadeLevels(fade({ stage: 'confirmation', rejectionHigh: 2.72, rejectionLow: 2.55, confirmLevel: 2.55 }));
    expect(levels.map((l) => l.title)).toEqual(['HOD · RISK', 'BROKE']);
  });

  it('adds the lower high from a failed bounce as the add risk', () => {
    const levels = fadeLevels(fade({ stage: 'fade', rejectionHigh: 2.72, rejectionLow: 2.55, confirmLevel: 2.55, lowerHigh: 2.52 }));
    expect(levels.at(-1)).toEqual({ kind: 'lowerHigh', price: 2.52, title: 'LH · ADD RISK' });
  });
});

describe('signalMarks', () => {
  const minuteBars = [0, 1, 2, 3, 4, 5].map((m) => T + m * MIN);

  it('puts each signal on the completed bar that produced it', () => {
    const marks = signalMarks([alert('rejection_confirmed', 4), alert('topping', 3), alert('new_high', 2)], 'RUN', minuteBars);
    expect(marks).toEqual([
      { barTime: T + 2 * MIN, type: 'topping', price: 2.5 },
      { barTime: T + 3 * MIN, type: 'rejection_confirmed', price: 2.5 },
    ]);
  });

  it('snaps to the containing bar on higher timeframes and skips other symbols and old alerts', () => {
    const fiveMin = [T, T + 5 * MIN];
    expect(signalMarks([alert('topping', 8), alert('topping', 7), alert('topping', 3, 'OTHER'), alert('vwap_bounce', 0)], 'RUN', fiveMin)).toEqual([
      { barTime: T + 5 * MIN, type: 'topping', price: 2.5 },
    ]);
  });
});
