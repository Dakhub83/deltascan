import type { Alert, AlertType, FadeSignal, FadeState } from '@deltascan/shared';

export type LevelKind = 'hod' | 'risk' | 'trigger' | 'confirmed' | 'lowerHigh' | 'backside';

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
  if (fade.backsideStop !== null) {
    // Usually the same price as RISK or LH: one line, named for the short.
    const same = out.findIndex((l) => l.kind !== 'hod' && l.kind !== 'trigger' && l.kind !== 'confirmed' && l.price === fade.backsideStop);
    if (same >= 0) out.splice(same, 1);
    out.push({ kind: 'backside', price: fade.backsideStop, title: 'SHORT · RISK' });
  }
  return out;
}

/**
 * Badge text and hint for the trader's scale-in: a front-side starter on the top, the rest once
 * it closes under VWAP. A failed bounce under VWAP is the next spot to add if the rest isn't on.
 */
export function stageAdvice(fade: FadeState, starterPct: number): { label: string | null; hint: string } {
  const rest = 100 - starterPct;
  if (fade.backsideStop !== null && fade.stage !== 'spike' && fade.stage !== 'extension') {
    return {
      label: 'BACKSIDE · SHORT',
      hint: `Topped, failed and under VWAP: the backside short. Risk over ${fade.backsideStop}. Off on a close back over VWAP.`,
    };
  }
  if (fade.vwapTest && !fade.vwapBroken && fade.stage !== 'spike' && fade.stage !== 'extension') {
    return {
      label: '→ VWAP · ANTICIPATE',
      hint: `Topped and fading into VWAP from above. The ${rest}% add is for the break; get ready, or lean in early with part of it.`,
    };
  }
  switch (fade.stage) {
    case 'spike':
      return { label: null, hint: '' };
    case 'extension':
      return { label: 'EXTENDED', hint: 'Extended above VWAP and making highs: wait for a topping tail or a failed new high.' };
    case 'rejection':
      return {
        label: `TOPPING · ${starterPct}% STARTER`,
        hint: `Front side: ${starterPct}% starter. Wrong on a new high over RISK. The other ${rest}% waits for a VWAP break.`,
      };
    case 'confirmation':
      return fade.vwapBroken
        ? { label: `UNDER VWAP · ADD ${rest}%`, hint: `Under VWAP: add the remaining ${rest}%. Off on a reclaim over VWAP.` }
        : { label: 'CONFIRMED', hint: `Rejection confirmed: hold the ${starterPct}% starter. The ${rest}% add comes on a close under VWAP.` };
    case 'fade':
      return fade.vwapBroken
        ? { label: `UNDER VWAP · ADD ${rest}%`, hint: `Under VWAP: the ${rest}% add. If it is already on, a failed bounce (LH) is the next spot; do not chase extended moves.` }
        : { label: 'FADING', hint: `Fading but still over VWAP: hold the starter, the ${rest}% add waits for a close under VWAP.` };
    case 'vwap-bounce':
      return { label: 'VWAP BOUNCE', hint: `Bounced back into VWAP from below: if it fails here, add whatever of the ${rest}% is not on yet.` };
  }
}

export const SIGNAL_TYPES: readonly AlertType[] = ['topping', 'rejection_confirmed', 'vwap_test', 'vwap_break', 'failed_bounce', 'vwap_bounce', 'backside'];

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

/**
 * Server-side signal history as alerts, so `signalMarks` places both the same way (an alert
 * lands a minute after its bar starts). Duplicates of live alerts collapse in `signalMarks`.
 */
export function signalsAsAlerts(symbol: string, signals: readonly FadeSignal[]): Alert[] {
  return signals.map((s) => ({
    id: `hist-${s.type}-${s.barTime}`,
    type: s.type,
    symbol,
    price: s.price,
    detail: s.detail,
    changePct: null,
    timestamp: s.barTime + 60_000,
  }));
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
