import type { SymbolSnapshot } from '@deltascan/shared';

export const TAPE_INDEXES = ['SPY', 'QQQ', 'IWM', 'DIA'];
const GAINERS = 12;
const LOSERS = 6;

/** Index ETFs first, then the biggest gainers and losers; halted names stay on so the halt is visible. */
export function pickTapeSymbols(rows: Iterable<SymbolSnapshot>): string[] {
  const all = [...rows].filter((r) => r.last != null);
  const indexes = TAPE_INDEXES.filter((s) => all.some((r) => r.symbol === s));
  const movers = all.filter((r) => !TAPE_INDEXES.includes(r.symbol) && r.changePct != null);
  const byChange = [...movers].sort((a, b) => b.changePct! - a.changePct!);
  const gainers = byChange.filter((r) => r.changePct! > 0).slice(0, GAINERS);
  const losers = byChange.filter((r) => r.changePct! < 0).slice(-LOSERS).reverse();
  const picked = new Set([...gainers, ...losers].map((r) => r.symbol));
  const halted = movers.filter((r) => r.halted && !picked.has(r.symbol)).map((r) => r.symbol);
  return [...indexes, ...gainers.map((r) => r.symbol), ...halted, ...losers.map((r) => r.symbol)];
}
