export interface PriceRange {
  min: number | null;
  max: number | null;
}

export const PRICE_PRESETS: { label: string; range: PriceRange }[] = [
  { label: 'Under $1', range: { min: null, max: 1 } },
  { label: '$1 – $5', range: { min: 1, max: 5 } },
  { label: '$1 – $10', range: { min: 1, max: 10 } },
  { label: '$2 – $20', range: { min: 2, max: 20 } },
  { label: '$5 – $50', range: { min: 5, max: 50 } },
  { label: 'Over $50', range: { min: 50, max: null } },
];

export const isActive = (r: PriceRange | undefined): r is PriceRange => !!r && (r.min !== null || r.max !== null);

/** Inclusive on both ends. A symbol with no price yet never passes an active range. */
export function inPriceRange(price: number | null | undefined, r: PriceRange | undefined): boolean {
  if (!isActive(r)) return true;
  if (price == null) return false;
  return (r.min === null || price >= r.min) && (r.max === null || price <= r.max);
}

const money = (n: number) => `$${n < 1 ? n.toString() : n.toLocaleString()}`;

export function rangeLabel(r: PriceRange | undefined): string {
  if (!isActive(r)) return 'Any price';
  if (r.min !== null && r.max !== null) return `${money(r.min)} – ${money(r.max)}`;
  return r.min !== null ? `Over ${money(r.min)}` : `Under ${money(r.max!)}`;
}

/** "" or junk → no bound; negative → no bound. */
export function parseBound(text: string): number | null {
  const n = Number(text.replace(/[$,\s]/g, ''));
  return text.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
}
