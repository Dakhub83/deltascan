import type { SymbolSnapshot } from '@deltascan/shared';

/** A scanner window's indicator conditions; every set condition must hold. */
export interface IndicatorFilter {
  rsiMin?: number | null;
  rsiMax?: number | null;
  /** EMA 9 / EMA 20 cross direction… */
  cross?: 'bull' | 'bear' | null;
  /** …within this many minutes (any time today when unset). */
  crossWithinMin?: number | null;
  /** Volume spike: relative volume at least this. */
  minRvol?: number | null;
}

export const RSI_OVERBOUGHT = 70;
export const RSI_OVERSOLD = 30;

export const isIndicatorFilterActive = (f: IndicatorFilter | undefined): f is IndicatorFilter =>
  !!f && (f.rsiMin != null || f.rsiMax != null || !!f.cross || f.minRvol != null);

/** Minutes since the latest EMA 9/20 cross, or null when there's none. */
export function minutesSinceCross(s: SymbolSnapshot, now: number): number | null {
  const at = s.indicators?.emaCross?.at;
  // `at` is the crossing bar's start; it closed a minute later.
  return at == null ? null : Math.max(0, (now - (at + 60_000)) / 60_000);
}

/** A symbol without indicators yet (too few bars) fails any active condition on them. */
export function passesIndicators(s: SymbolSnapshot, f: IndicatorFilter | undefined, now: number): boolean {
  if (!isIndicatorFilterActive(f)) return true;
  if (f.minRvol != null && (s.rvol == null || s.rvol < f.minRvol)) return false;
  const rsi = s.indicators?.rsi14 ?? null;
  if (f.rsiMin != null && (rsi === null || rsi < f.rsiMin)) return false;
  if (f.rsiMax != null && (rsi === null || rsi > f.rsiMax)) return false;
  if (f.cross) {
    const cross = s.indicators?.emaCross;
    if (!cross || cross.dir !== f.cross) return false;
    if (f.crossWithinMin != null && (minutesSinceCross(s, now) ?? Infinity) > f.crossWithinMin) return false;
  }
  return true;
}

export function indicatorLabel(f: IndicatorFilter | undefined): string {
  if (!isIndicatorFilterActive(f)) return 'Indicators';
  const parts: string[] = [];
  if (f.rsiMin != null && f.rsiMax != null) parts.push(`RSI ${f.rsiMin}–${f.rsiMax}`);
  else if (f.rsiMin != null) parts.push(`RSI ≥ ${f.rsiMin}`);
  else if (f.rsiMax != null) parts.push(`RSI ≤ ${f.rsiMax}`);
  if (f.cross) parts.push(`EMA ${f.cross === 'bull' ? '▲' : '▼'}${f.crossWithinMin != null ? ` ${f.crossWithinMin}m` : ''}`);
  if (f.minRvol != null) parts.push(`RVOL ≥ ${f.minRvol}×`);
  return parts.join(' · ');
}
