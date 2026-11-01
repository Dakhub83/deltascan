import { describe, expect, it } from 'vitest';
import { floatLabel, inFloatRange, parseFloatBound } from './floatRange';

describe('float range', () => {
  it('filters inclusively and lets unknown floats through', () => {
    const r = { min: 1e6, max: 10e6 };
    expect([999_999, 1e6, 5e6, 10e6, 10_000_001].map((f) => inFloatRange(f, r))).toEqual([false, true, true, true, false]);
    expect(inFloatRange(null, r)).toBe(true);
    expect(inFloatRange(800e6, undefined)).toBe(true);
    expect(inFloatRange(800e6, { min: null, max: null })).toBe(true);
  });

  it('reads bounds in millions by default, with K / M suffixes and full share counts', () => {
    expect(['5', '1.5m', '1.5M', '500K', '2,000,000', '', 'abc', '-3'].map(parseFloatBound)).toEqual([5e6, 1.5e6, 1.5e6, 500_000, 2e6, null, null, null]);
  });

  it('labels ranges', () => {
    expect([floatLabel({ min: 1e6, max: 10e6 }), floatLabel({ min: null, max: 5e6 }), floatLabel({ min: 50e6, max: null }), floatLabel(undefined)]).toEqual([
      'Float 1M – 10M',
      'Float under 5M',
      'Float over 50M',
      'Any float',
    ]);
    expect(floatLabel({ min: null, max: 750_000 })).toBe('Float under 750K');
  });
});
