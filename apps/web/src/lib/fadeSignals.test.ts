import { describe, expect, it } from 'vitest';
import type { Alert, FadeState } from '@deltascan/shared';
import { fadeLevels, signalMarks, signalsAsAlerts, stageAdvice } from './fadeSignals';

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
  vwapBroken: false,
  backsideStop: null,
  vwapTest: false,
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

describe('signalsAsAlerts', () => {
  it('places history on its bar and merges with the live alert for the same signal', () => {
    const history = signalsAsAlerts('RUN', [
      { type: 'topping', barTime: T + 2 * MIN, price: 2.58, detail: 'replayed' },
      { type: 'vwap_break', barTime: T + 4 * MIN, price: 2.2, detail: 'replayed' },
    ]);
    const bars = [0, 1, 2, 3, 4, 5].map((m) => T + m * MIN);
    // The live alert for the topping arrived too: still one mark.
    expect(signalMarks([alert('topping', 3), ...history], 'RUN', bars)).toEqual([
      { barTime: T + 2 * MIN, type: 'topping', price: 2.5 },
      { barTime: T + 4 * MIN, type: 'vwap_break', price: 2.2 },
    ]);
  });
});

describe('stageAdvice', () => {
  it('sizes the starter on the top and the rest on the VWAP break', () => {
    expect(stageAdvice(fade({ stage: 'rejection' }), 30).label).toBe('TOPPING · 30% STARTER');
    expect(stageAdvice(fade({ stage: 'confirmation' }), 30)).toMatchObject({ label: 'CONFIRMED' });
    expect(stageAdvice(fade({ stage: 'confirmation' }), 30).hint).toContain('70% add comes on a close under VWAP');
    expect(stageAdvice(fade({ stage: 'fade', vwapBroken: true }), 30).label).toBe('UNDER VWAP · ADD 70%');
    expect(stageAdvice(fade({ stage: 'fade', vwapBroken: true }), 25).label).toBe('UNDER VWAP · ADD 75%');
    expect(stageAdvice(fade({ stage: 'spike' }), 30).label).toBeNull();
  });
});

describe('backside on the chart', () => {
  it('draws one SHORT · RISK line in place of the matching RISK or LH line', () => {
    const levels = fadeLevels(fade({ stage: 'fade', rejectionHigh: 2.7, rejectionLow: 2.55, confirmLevel: 2.55, backsideStop: 2.7 }));
    expect(levels.map((l) => l.title)).toEqual(['HOD', 'BROKE', 'SHORT · RISK']);
    const lh = fadeLevels(fade({ stage: 'fade', lowerHigh: 2.4, backsideStop: 2.4 }));
    expect(lh.map((l) => `${l.title} ${l.price}`)).toEqual(['HOD 2.72', 'SHORT · RISK 2.4']);
  });

  it('labels the badge BACKSIDE · SHORT until a new high resets the setup', () => {
    expect(stageAdvice(fade({ stage: 'fade', vwapBroken: true, backsideStop: 2.7 }), 30)).toMatchObject({ label: 'BACKSIDE · SHORT' });
    expect(stageAdvice(fade({ stage: 'fade', vwapBroken: true, backsideStop: 2.7 }), 30).hint).toContain('Risk over 2.7');
    expect(stageAdvice(fade({ stage: 'extension', backsideStop: null }), 30).label).toBe('EXTENDED');
  });
});

describe('fading into VWAP on the chart', () => {
  it('shows the anticipation badge until the break, then the add', () => {
    expect(stageAdvice(fade({ stage: 'confirmation', vwapTest: true }), 30).label).toBe('→ VWAP · ANTICIPATE');
    expect(stageAdvice(fade({ stage: 'fade', vwapTest: false, vwapBroken: true }), 30).label).toBe('UNDER VWAP · ADD 70%');
  });
});
