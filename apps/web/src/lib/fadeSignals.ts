import type { Alert, AlertType, FadeState } from '@deltascan/shared';

export type LevelKind = 'hod' | 'risk' | 'trigger' | 'confirmed' | 'lowerHigh';

export interface FadeLevel {
  kind: LevelKind;
  price: number;
  title: string;
}

/** Short-side levels to draw for the current setup: the high, where the starter is wrong, and the add trigger. */
export function fadeLevels(fade: FadeState | null): FadeLevel[] {
  if (!fade || fade.stage === 'spike') return [];
  const out: FadeLevel[] = [{ kind: 'hod', price: fade.high, title: 'HOD' }];
  if (fade.rejectionHigh !== null && fade.rejectionHigh !== fade.high) out.push({ kind: 'risk', price: fade.rejectionHigh, title: 'RISK' });
  else if (fade.rejectionHigh !== null) out[0] = { kind: 'risk', price: fade.high, title: 'HOD · RISK' };
  if (fade.stage === 'rejection' && fade.rejectionLow !== null) out.push({ kind: 'trigger', price: fade.rejectionLow, title: 'CONFIRMS <' });
  if (fade.confirmLevel !== null && fade.stage !== 'rejection') out.push({ kind: 'confirmed', price: fade.confirmLevel, title: 'BROKE' });
  if (fade.lowerHigh !== null && fade.stage !== 'rejection') out.push({ kind: 'lowerHigh', price: fade.lowerHigh, title: 'LH · ADD RISK' });
  return out;
}

export const SIGNAL_TYPES: readonly AlertType[] = ['topping', 'rejection_confirmed', 'failed_bounce', 'vwap_bounce'];

export interface SignalMark {
  /** Start of the displayed bar the signal belongs to. */
  barTime: number;
  type: AlertType;
  price: number;
}

/**
 * Places short-side alerts on the bar that produced them. Alerts fire once a 1-minute bar
 * completes, so the signal bar is the minute before the alert; on higher timeframes it's the
 * bar containing that minute. Signals before the first bar are dropped; one mark per bar and type.
 */
export function signalMarks(alerts: readonly Alert[], symbol: string, barTimes: readonly number[]): SignalMark[] {
  if (!barTimes.length) return [];
  const seen = new Set<string>();
  const out: SignalMark[] = [];
  for (const a of alerts) {
    if (a.symbol !== symbol || !SIGNAL_TYPES.includes(a.type)) continue;
    const at = a.timestamp - 60_000;
    if (at < barTimes[0]!) continue;
    const barTime = barTimes[lastAtOrBefore(barTimes, at)]!;
    const key = `${barTime}|${a.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ barTime, type: a.type, price: a.price });
  }
  return out.sort((x, y) => x.barTime - y.barTime);
}

function lastAtOrBefore(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sorted[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
