import type { PriceRange } from './priceRange';

/** Min / max float in shares; either end may be open. Same shape as a price range. */
export type FloatRange = PriceRange;

const M = 1e6;

export const FLOAT_PRESETS: { label: string; range: FloatRange }[] = [
  { label: 'Under 1M', range: { min: null, max: 1 * M } },
  { label: 'Under 5M', range: { min: null, max: 5 * M } },
  { label: '1M – 10M', range: { min: 1 * M, max: 10 * M } },
  { label: 'Under 20M', range: { min: null, max: 20 * M } },
  { label: '5M – 30M', range: { min: 5 * M, max: 30 * M } },
  { label: 'Over 50M', range: { min: 50 * M, max: null } },
];

/**
 * Inclusive on both ends. An unknown float passes: the live feed has no float data yet
 * (ARCHITECTURE step 4), and hiding unknowns would empty every scanner.
 */
export function inFloatRange(float: number | null | undefined, r: FloatRange | undefined): boolean {
  if (!r || (r.min === null && r.max === null) || float == null) return true;
  return (r.min === null || float >= r.min) && (r.max === null || float <= r.max);
}

/** 1500000 → "1.5M", 750000 → "750K". */
export function fmtShares(n: number): string {
  if (n >= M) return `${+(n / M).toFixed(2)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function floatLabel(r: FloatRange | undefined): string {
  if (!r || (r.min === null && r.max === null)) return 'Any float';
  if (r.min !== null && r.max !== null) return `Float ${fmtShares(r.min)} – ${fmtShares(r.max)}`;
  return r.min !== null ? `Float over ${fmtShares(r.min)}` : `Float under ${fmtShares(r.max!)}`;
}

/** Reads "5", "5M", "1.5m", "500K" or "2,000,000". A bare number is millions. Junk → no bound. */
export function parseFloatBound(text: string): number | null {
  const m = /^\s*([\d,]*\.?\d+)\s*([kKmM]?)\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]!.toLowerCase();
  if (unit === 'k') return Math.round(n * 1e3);
  if (unit === 'm' || n < 10_000) return Math.round(n * M);
  return Math.round(n);
}
