import type { FadeStage, SymbolSnapshot } from '@deltascan/shared';

/** Fade-scanner thresholds. Float isn't filtered: the trader shorts runners of any float. */
export const FADE = {
  /** Flagged LATE once this far off the high, or this long since it: adding there is chasing the back side. */
  lateOffHighPct: 25,
  lateMinutes: 45,
};

export const STAGE_META: Record<FadeStage, { label: string; badge: string; order: number }> = {
  confirmation: { label: 'CONFIRMED', badge: 'bg-down/15 text-down ring-down/30', order: 0 },
  'vwap-bounce': { label: 'VWAP BOUNCE', badge: 'bg-violet/15 text-violet ring-violet/30', order: 1 },
  rejection: { label: 'REJECTING', badge: 'bg-warn/15 text-warn ring-warn/30', order: 2 },
  extension: { label: 'EXTENDED', badge: 'bg-up/12 text-up ring-up/25', order: 3 },
  fade: { label: 'FADING', badge: 'bg-line text-dim ring-line-strong', order: 4 },
  spike: { label: 'SPIKE', badge: 'bg-line text-muted ring-line', order: 5 },
};

export const offHighPct = (s: SymbolSnapshot) => (s.fade && s.last != null ? (1 - s.last / s.fade.high) * 100 : null);
export const minutesSinceHigh = (s: SymbolSnapshot, now = Date.now()) => (s.fade ? Math.max(0, (now - s.fade.highAt) / 60_000) : null);

export function isLate(s: SymbolSnapshot): boolean {
  const off = offHighPct(s);
  const mins = minutesSinceHigh(s);
  return (off !== null && off >= FADE.lateOffHighPct) || (mins !== null && mins >= FADE.lateMinutes);
}
