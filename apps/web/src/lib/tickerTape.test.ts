import { describe, expect, it } from 'vitest';
import type { SymbolSnapshot } from '@deltascan/shared';
import { pickTapeSymbols } from './tickerTape';

const row = (symbol: string, changePct: number | null, over: Partial<SymbolSnapshot> = {}) =>
  ({ symbol, last: 1, changePct, halted: false, ...over }) as SymbolSnapshot;

describe('pickTapeSymbols', () => {
  it('puts indexes first, then gainers high to low, halted names, then losers worst first', () => {
    const rows = [
      row('LOSE1', -3),
      row('GAIN1', 12),
      row('SPY', 0.2),
      row('HALT', 0, { halted: true }),
      row('LOSE2', -20),
      row('GAIN2', 40),
      row('NOPRICE', 90, { last: null }),
      row('FLAT', 0),
    ];
    expect(pickTapeSymbols(rows)).toEqual(['SPY', 'GAIN2', 'GAIN1', 'HALT', 'LOSE2', 'LOSE1']);
  });

  it('caps the gainers and losers', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`S${i}`, i - 20));
    const picked = pickTapeSymbols(rows);
    expect(picked).toHaveLength(18);
    expect(picked[0]).toBe('S39');
    expect(picked[12]).toBe('S0'); // worst loser first
  });
});
