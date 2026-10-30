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
  it('walks Spike → Extension → Rejection → Confirmation, alerting topping then the confirmation', () => {
    expect(run([SPIKE]).state?.stage).toBe('spike');
    expect(run([SPIKE, EXTEND]).state?.stage).toBe('extension');
    expect(run([SPIKE, EXTEND, REJECT]).state).toMatchObject({ stage: 'rejection', rejectionHigh: 2.72 });
    const confirmed = run([SPIKE, EXTEND, REJECT, CONFIRM]);
    expect(confirmed.state).toMatchObject({ stage: 'confirmation', confirmLevel: 2.55, high: 2.72 });
    expect(confirmed.alerts).toEqual(['topping', 'rejection_confirmed']);
  });

  it('does not confirm while the rejection bar is still forming', () => {
    // CONFIRM is the trailing in-progress bar here, so it must be ignored.
    const alerts: string[] = [];
    const d = new FadeDetector((t) => alerts.push(t), { alertMaxAgeMs: Infinity });
    const b = bars([SPIKE, EXTEND, REJECT]);
    b[b.length - 1] = { ...b.at(-1)!, open: 2.58, high: 2.6, low: 2.45, close: 2.5 };
    expect(d.evaluate(snap(), b, NOW)?.stage).toBe('rejection');
    expect(alerts).toEqual(['topping']);
  });

  it('alerts topping on a topping tail with the risk and confirmation levels', () => {
    const details: string[] = [];
    const d = new FadeDetector((type, _s, _p, detail) => details.push(`${type}: ${detail}`), { alertMaxAgeMs: Infinity });
    const state = d.evaluate(snap(), bars([SPIKE, EXTEND, REJECT]), NOW);
    expect(state).toMatchObject({ stage: 'rejection', rejectionHigh: 2.72, rejectionLow: 2.55, confirmLevel: null });
    expect(details).toEqual(['topping: Topping tail at 2.72 (41% wick) · starter: risk over 2.72, confirms under 2.55']);
  });

  it('alerts topping on a reversal candle that opens at the high and sells straight down (XRTA)', () => {
    // Real sequence from the simulated feed: prevClose 2.96, VWAP 3.67, a 5.30 new high that closed at its low.
    const details: string[] = [];
    const d = new FadeDetector((type, _s, _p, detail) => details.push(`${type}: ${detail}`), { alertMaxAgeMs: Infinity });
    const xrta: [number, number, number, number][] = [
      [3.94, 5.14, 3.94, 4.86],
      [4.86, 4.98, 4.52, 4.93],
      [4.21, 4.84, 4.17, 4.84],
      [4.92, 4.96, 4.92, 4.96],
      [4.95, 5.21, 4.71, 4.71],
      [4.7, 5.2, 4.48, 5.2],
      [5.2, 5.3, 4.6, 4.6], // 13% range, 14% upper wick, closes at the low
    ];
    const state = d.evaluate(snap({ prevClose: 2.96, vwap: 3.67 }), bars(xrta), NOW);
    expect(state).toMatchObject({ stage: 'rejection', rejectionHigh: 5.3, rejectionLow: 4.6 });
    expect(details.at(-1)).toBe('topping: Reversal candle off 5.30: 13.2% range, closed 4.60 near the low · starter: risk over 5.30, confirms under 4.60');
  });

  it("doesn't call a small red candle at the high a reversal", () => {
    // Closes at its low but the range is under 3% of the price: noise, not a top.
    const small: [number, number, number, number] = [2.69, 2.7, 2.65, 2.65];
    expect(run([SPIKE, EXTEND, small]).alerts).not.toContain('topping');
  });

  it('alerts topping when it stalls under the high and a red bar breaks the prior low', () => {
    const details: string[] = [];
    const d = new FadeDetector((type, _s, _p, detail) => details.push(`${type}: ${detail}`), { alertMaxAgeMs: Infinity });
    const hold: [number, number, number, number] = [2.65, 2.68, 2.6, 2.66];
    const failing: [number, number, number, number] = [2.66, 2.66, 2.56, 2.57]; // red, under the prior low 2.60
    d.evaluate(snap(), bars([SPIKE, EXTEND, hold, hold, failing]), NOW);
    expect(details).toEqual(['topping: Failed at 2.70 for 3m, red bar broke 2.60 · starter: risk over 2.70, confirms under 2.56']);
  });

  describe('failed bounce', () => {
    const DROP: [number, number, number, number] = [2.5, 2.52, 2.4, 2.42]; // the leg down: low 2.40
    const BOUNCE: [number, number, number, number] = [2.42, 2.52, 2.46, 2.5]; // retraces 0.12 of the 0.32 drop from 2.72
    const ROLL: [number, number, number, number] = [2.5, 2.51, 2.43, 2.44]; // red, closes under the bounce bar's low

    it('alerts when a backside bounce makes a lower high and rolls over', () => {
      const details: string[] = [];
      const d = new FadeDetector((type, _s, _p, detail) => details.push(`${type}: ${detail}`), { alertMaxAgeMs: Infinity });
      const state = d.evaluate(snap(), bars([SPIKE, EXTEND, REJECT, CONFIRM, DROP, BOUNCE, ROLL]), NOW);
      expect(state).toMatchObject({ stage: 'fade', lowerHigh: 2.52 });
      expect(details.at(-1)).toBe('failed_bounce: Lower high 2.52 under 2.72, bounce off 2.40 failed · add: risk over 2.52');
    });

    it('ignores a bounce too small to be one, and one that rolls over too late', () => {
      const tiny: [number, number, number, number] = [2.42, 2.45, 2.42, 2.44];
      const tinyRoll: [number, number, number, number] = [2.44, 2.44, 2.41, 2.41];
      expect(run([SPIKE, EXTEND, REJECT, CONFIRM, DROP, tiny, tinyRoll]).alerts).not.toContain('failed_bounce');
      const hold: [number, number, number, number] = [2.5, 2.51, 2.47, 2.49];
      const late = run([SPIKE, EXTEND, REJECT, CONFIRM, DROP, BOUNCE, hold, hold, hold, hold, ROLL]);
      expect(late.alerts).not.toContain('failed_bounce');
    });

    it('a new high clears the lower high', () => {
      const r = run([SPIKE, EXTEND, REJECT, CONFIRM, DROP, BOUNCE, ROLL, [2.44, 2.8, 2.44, 2.78]]);
      expect(r.state).toMatchObject({ stage: 'extension', lowerHigh: null });
    });
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
    expect(r.alerts).toEqual(['topping', 'rejection_confirmed', 'vwap_break', 'vwap_bounce']);
  });

  it('alerts vwap_break once on the first close under VWAP after the top', () => {
    const details: string[] = [];
    const d = new FadeDetector((type, _s, _p, detail) => details.push(`${type}: ${detail}`), { alertMaxAgeMs: Infinity });
    const lose: [number, number, number, number] = [2.5, 2.5, 2.2, 2.22];
    const lower: [number, number, number, number] = [2.22, 2.24, 2.1, 2.12];
    const state = d.evaluate(snap(), bars([SPIKE, EXTEND, REJECT, CONFIRM, lose, lower]), NOW);
    expect(state).toMatchObject({ stage: 'fade', vwapBroken: true });
    expect(details.filter((x) => x.startsWith('vwap_break'))).toEqual([
      'vwap_break: Closed 2.22 under VWAP 2.30, 18.4% off high · add the rest; off on a close over 2.33',
    ]);
  });

  it("doesn't call a VWAP break before the stock has topped", () => {
    // Extended names sit above VWAP by definition; a spike that never extended isn't a short yet.
    const r = run([SPIKE, [2.35, 2.36, 2.25, 2.28]]);
    expect(r.alerts).not.toContain('vwap_break');
  });

  it('a VWAP reclaim clears the break so the next one alerts again', () => {
    const lose: [number, number, number, number] = [2.5, 2.5, 2.2, 2.22];
    const bounce: [number, number, number, number] = [2.22, 2.29, 2.2, 2.26];
    const reclaim: [number, number, number, number] = [2.26, 2.4, 2.26, 2.38];
    const r = run([SPIKE, EXTEND, REJECT, CONFIRM, lose, bounce, reclaim]);
    expect(r.state).toMatchObject({ stage: 'spike', vwapBroken: false });
  });

  it('a candle that opens over VWAP and closes under it is a break, not a bounce', () => {
    // VWAP 2.00. Topped without a clean rejection: 17% off the high, straight to fade, still over VWAP.
    const flush: [number, number, number, number] = [2.65, 2.65, 2.24, 2.25];
    const through: [number, number, number, number] = [2.25, 2.26, 1.88, 1.9]; // opens over VWAP, closes under
    expect(run([SPIKE, EXTEND, flush], { vwap: 2.0 }).state).toMatchObject({ stage: 'fade', vwapBroken: false });
    const r = run([SPIKE, EXTEND, flush, through], { vwap: 2.0 });
    expect(r.state).toMatchObject({ stage: 'fade', vwapBroken: true });
    expect(r.alerts).toEqual(['vwap_break']);
  });

  it('a squeeze back over VWAP clears the break even below the high, and the next break alerts', () => {
    const lose: [number, number, number, number] = [2.5, 2.5, 2.2, 2.22];
    const squeeze: [number, number, number, number] = [2.22, 2.6, 2.22, 2.58]; // over VWAP 2.30, under the 2.72 high
    const again: [number, number, number, number] = [2.58, 2.58, 2.2, 2.21];
    const squeezed = run([SPIKE, EXTEND, REJECT, CONFIRM, lose, squeeze]);
    expect(squeezed.state).toMatchObject({ stage: 'fade', vwapBroken: false });
    const broke = run([SPIKE, EXTEND, REJECT, CONFIRM, lose, squeeze, again]);
    expect(broke.state?.vwapBroken).toBe(true);
    expect(broke.alerts.filter((a) => a === 'vwap_break')).toHaveLength(2);
  });

  it('ignores sub-$1 names but tracks any float', () => {
    expect(run([SPIKE, EXTEND], { last: 0.6 }).state).toBeNull();
    expect(run([SPIKE, EXTEND], { floatShares: 500_000, last: 2.65 }).state?.stage).toBe('extension');
    expect(run([SPIKE, EXTEND], { floatShares: 800e6, last: 2.65 }).state?.stage).toBe('extension');
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
