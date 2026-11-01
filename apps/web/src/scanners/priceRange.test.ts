import { describe, expect, it } from 'vitest';
import { inPriceRange, parseBound, rangeLabel } from './priceRange';

describe('price range', () => {
  it('filters inclusively and lets everything through when unset', () => {
    const r = { min: 1, max: 10 };
    expect([0.99, 1, 5, 10, 10.01].map((p) => inPriceRange(p, r))).toEqual([false, true, true, true, false]);
    expect(inPriceRange(null, r)).toBe(false);
    expect(inPriceRange(null, undefined)).toBe(true);
    expect(inPriceRange(500, { min: null, max: null })).toBe(true);
    expect(inPriceRange(0.5, { min: null, max: 1 })).toBe(true);
  });

  it('labels and parses ranges', () => {
    expect([rangeLabel({ min: 1, max: 10 }), rangeLabel({ min: null, max: 1 }), rangeLabel({ min: 50, max: null }), rangeLabel(undefined)]).toEqual([
      '$1 – $10',
      'Under $1',
      'Over $50',
      'Any price',
    ]);
    expect([parseBound('$2.50'), parseBound(''), parseBound('abc'), parseBound('-3'), parseBound('1,000')]).toEqual([2.5, null, null, null, 1000]);
  });
});
