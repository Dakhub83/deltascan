import { describe, expect, it } from 'vitest';
import { marketSessionAt, tradeSessionAt } from '../src/market/sessionClock';

// 2026-10-21 is a Wednesday; EDT is UTC-4.
const et = (hhmm: string, day = '2026-10-21') => Date.parse(`${day}T${hhmm}:00-04:00`);

describe('sessionClock', () => {
  it('classifies trades by ET session boundaries', () => {
    expect(tradeSessionAt(et('08:15'))).toBe('pre');
    expect(tradeSessionAt(et('09:29'))).toBe('pre');
    expect(tradeSessionAt(et('09:30'))).toBe('regular');
    expect(tradeSessionAt(et('15:59'))).toBe('regular');
    expect(tradeSessionAt(et('16:00'))).toBe('post');
    expect(tradeSessionAt(et('19:30'))).toBe('post');
  });

  it('reports closed overnight and on weekends', () => {
    expect(marketSessionAt(et('03:59'))).toBe('closed');
    expect(marketSessionAt(et('04:00'))).toBe('pre');
    expect(marketSessionAt(et('20:00'))).toBe('closed');
    expect(marketSessionAt(et('11:00', '2026-10-24'))).toBe('closed'); // Saturday
  });
});
