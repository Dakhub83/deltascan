import { describe, expect, it } from 'vitest';
import type { Bar, SymbolSnapshot } from '@deltascan/shared';
import { FadeDetector } from '../src/scanner/FadeDetector';

const T0 = Date.parse('2026-10-23T14:00:00Z');
const NOW = T0 + 60 * 60_000;

/** [open, high, low, close] per minute; a trailing in-progress bar is appended automatically. */
function bars(ohlc: [number, number, number, number][], session: Bar['session'] = 'regular'): Bar[] {
  const out = ohlc.map(([open, high, low, close], i) => ({ symbol: 'RUN', open, high, low, close, volume: 1000, timestamp: T0 + i * 60_000, session }));
  return [...out, { ...out.at(-1)!, timestamp: T0 + ohlc.length * 60_000 }];
}

const snap = (over: Partial<SymbolSnapshot> = {}) => ({ symbol: 'RUN', prevClose: 2, vwap: 2.3, ...over }) as SymbolSnapshot;

function run(ohlc: [number, number, number, number][], over: Partial<SymbolSnapshot> = {}, now = NOW) {
  const alerts: string[] = [];
  const d = new FadeDetector((type) => alerts.push(type), { alertMaxAgeMs: Infinity });
  return { state: d.evaluate(snap(over), bars(ohlc), now), alerts };
}

// prevClose 2.00, VWAP 2.30: a 15%+ spike is a close ≥ 2.30, an extension a new high closing ≥ 2.415.
const SPIKE: [number, number, number, number] = [2.2, 2.4, 2.2, 2.35];
const EXTEND: [number, number, number, number] = [2.35, 2.7, 2.35, 2.65];
const REJECT: [number, number, number, number] = [2.65, 2.72, 2.55, 2.58]; // wick 0.07 of 0.17 range, red
const CONFIRM: [number, number, number, number] = [2.58, 2.6, 2.45, 2.5]; // closes below 2.55

describe('FadeDetector', () => {
  it('walks Spike → Extension → Rejection → Confirmation and alerts on the confirmation', () => {
    expect(run([SPIKE]).state?.stage).toBe('spike');
    expect(run([SPIKE, EXTEND]).state?.stage).toBe('extension');
    expect(run([SPIKE, EXTEND, REJECT]).state).toMatchObject({ stage: 'rejection', rejectionHigh: 2.72 });
    const confirmed = run([SPIKE, EXTEND, REJECT, CONFIRM]);
    expect(confirmed.state).toMatchObject({ stage: 'confirmation', confirmLevel: 2.55, high: 2.72 });
    expect(confirmed.alerts).toEqual(['rejection_confirmed']);
  });

  it('does not confirm while the rejection bar is still forming', () => {
    // CONFIRM is the trailing in-progress bar here, so it must be ignored.
    const alerts: string[] = [];
    const d = new FadeDetector((t) => alerts.push(t), { alertMaxAgeMs: Infinity });
    const b = bars([SPIKE, EXTEND, REJECT]);
    b[b.length - 1] = { ...b.at(-1)!, open: 2.58, high: 2.6, low: 2.45, close: 2.5 };
    expect(d.evaluate(snap(), b, NOW)?.stage).toBe('rejection');
    expect(alerts).toEqual([]);
  });

  it("doesn't alert a confirmation that comes too far off the high (the back side)", () => {
    // A wide rejection candle whose low is 20% under the high: closing below it is too late.
    const wide: [number, number, number, number] = [2.65, 2.72, 2.17, 2.2];
    const r = run([SPIKE, EXTEND, wide, [2.2, 2.2, 2.1, 2.12]], { vwap: 2.0 });
    expect(r.state?.stage).toBe('fade');
    expect(r.alerts).toEqual([]);
  });

  it('a new high above the rejection candle sends it back to Extension', () => {
    expect(run([SPIKE, EXTEND, REJECT, [2.58, 2.8, 2.56, 2.78]]).state).toMatchObject({ stage: 'extension', rejectionHigh: null });
  });

  it('becomes a fade on losing VWAP, then a backside bounce into VWAP from below', () => {
    const lose: [number, number, number, number] = [2.5, 2.5, 2.2, 2.22];
    const bounce: [number, number, number, number] = [2.22, 2.29, 2.2, 2.26]; // high within 1.5% of 2.30, closes under
    const r = run([SPIKE, EXTEND, REJECT, CONFIRM, lose, bounce]);
    expect(r.state?.stage).toBe('vwap-bounce');
    expect(r.alerts).toEqual(['rejection_confirmed', 'vwap_bounce']);
  });

  it('ignores names outside the price and float floors', () => {
    expect(run([SPIKE, EXTEND], { floatShares: 500_000 }).state).toBeNull(); // too low a float
    expect(run([SPIKE, EXTEND], { floatShares: 800e6 }).state).toBeNull(); // large cap
    expect(run([SPIKE, EXTEND], { last: 0.6 }).state).toBeNull(); // sub-$1
    expect(run([SPIKE, EXTEND], { floatShares: 10e6, last: 2.65 }).state?.stage).toBe('extension');
  });

  it('replays backfilled history without alerting', () => {
    const alerts: string[] = [];
    const d = new FadeDetector((t) => alerts.push(t), { alertMaxAgeMs: 3 * 60_000 });
    // The bars are an hour old by NOW: the stage is restored, but nothing fires.
    expect(d.evaluate(snap(), bars([SPIKE, EXTEND, REJECT, CONFIRM]), NOW)?.stage).toBe('confirmation');
    expect(alerts).toEqual([]);
  });

  it('starts over when the session changes (pre-market → regular)', () => {
    const d = new FadeDetector(() => {}, { alertMaxAgeMs: Infinity });
    expect(d.evaluate(snap(), bars([SPIKE, EXTEND], 'pre'), NOW)?.stage).toBe('extension');
    const regular = bars([[2.0, 2.05, 1.98, 2.02]], 'regular').map((b) => ({ ...b, timestamp: b.timestamp + 10 * 60_000 }));
    expect(d.evaluate(snap(), [...bars([SPIKE, EXTEND], 'pre').slice(0, -1), ...regular], NOW)).toBeNull();
  });
});
