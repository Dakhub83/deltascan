import type { Alert, SymbolSnapshot } from '@deltascan/shared';
import { inPriceRange, type PriceRange } from '../scanners/priceRange';
import { inFloatRange, type FloatRange } from '../scanners/floatRange';

/** Repeats inside this window are what "keeps pushing" means. */
export const STREAK_WINDOW_MS = 10 * 60_000;
/** A stock that pushed and then went this long without a new high has stalled: fade watch. */
export const QUIET_AFTER_MS = 3 * 60_000;

/** One new-high-of-day alert, with how often the stock had made new highs when it fired. */
export interface NhodRow {
  id: string;
  symbol: string;
  timestamp: number;
  price: number;
  changePct: number | null;
  /** This alert's number among the symbol's NHODs that ET day (1 = first). */
  nth: number;
  /** NHODs in the STREAK_WINDOW_MS ending at this alert, itself included. */
  recent: number;
}

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** NHOD rows, newest first, from the alert feed (newest first, any types). */
export function nhodRows(alerts: readonly Alert[]): NhodRow[] {
  const bySymbol = new Map<string, Alert[]>();
  for (let i = alerts.length - 1; i >= 0; i--) {
    const a = alerts[i]!;
    if (a.type !== 'new_high') continue;
    let list = bySymbol.get(a.symbol);
    if (!list) bySymbol.set(a.symbol, (list = []));
    list.push(a);
  }
  const rows: NhodRow[] = [];
  for (const list of bySymbol.values()) {
    let day = '';
    let nth = 0;
    let start = 0;
    list.forEach((a, i) => {
      const d = etDate.format(a.timestamp);
      if (d !== day) {
        day = d;
        nth = 0;
        start = i;
      }
      nth++;
      while (list[start]!.timestamp <= a.timestamp - STREAK_WINDOW_MS) start++;
      rows.push({ id: a.id, symbol: a.symbol, timestamp: a.timestamp, price: a.price, changePct: a.changePct, nth, recent: i - start + 1 });
    });
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/** One row per symbol (its latest NHOD), the most active first. `recent` is recounted at `now`. */
export function nhodLeaders(rows: readonly NhodRow[], now: number): NhodRow[] {
  const latest = new Map<string, NhodRow>();
  const recent = new Map<string, number>();
  for (const r of rows) {
    if (!latest.has(r.symbol)) latest.set(r.symbol, r);
    if (r.timestamp > now - STREAK_WINDOW_MS) recent.set(r.symbol, (recent.get(r.symbol) ?? 0) + 1);
  }
  return [...latest.values()]
    .map((r) => ({ ...r, recent: recent.get(r.symbol) ?? 0 }))
    .sort((a, b) => b.recent - a.recent || b.nth - a.nth || b.timestamp - a.timestamp);
}

/** Each symbol's latest NHOD (rows newest first). */
export function lastNhodBySymbol(rows: readonly NhodRow[]): Map<string, NhodRow> {
  const out = new Map<string, NhodRow>();
  for (const r of rows) if (!out.has(r.symbol)) out.set(r.symbol, r);
  return out;
}

/** Pushed at least twice, then nothing for QUIET_AFTER_MS: the run may be topping. */
export const isQuiet = (nth: number, lastTs: number, now: number) => nth >= 2 && now - lastTs >= QUIET_AFTER_MS;

export interface NhodFilter {
  priceRange?: PriceRange;
  floatRange?: FloatRange;
  minRvol?: number | null;
  /** Minimum NHODs in the last STREAK_WINDOW_MS. */
  minRepeats?: number | null;
}

/** Price / float / RVOL come from the live snapshot, so a row follows the stock as it moves. */
export function passesNhodFilter(row: NhodRow, snap: SymbolSnapshot | undefined, f: NhodFilter): boolean {
  if (f.minRepeats && row.recent < f.minRepeats) return false;
  if (!inPriceRange(snap?.last ?? row.price, f.priceRange)) return false;
  if (!inFloatRange(snap?.floatShares, f.floatRange)) return false;
  if (f.minRvol && (snap?.rvol == null || snap.rvol < f.minRvol)) return false;
  return true;
}

/** 42_000 → "42s", 330_000 → "5m 30s", 4_000_000 → "1h 6m". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
