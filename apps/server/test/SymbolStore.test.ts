import { describe, expect, it } from 'vitest';
import { SymbolStore } from '../src/cache/SymbolStore';

const trade = (price: number, size: number, timestamp = 1) => ({ symbol: 'ABC', price, size, timestamp });

describe('SymbolStore', () => {
  it('aggregates trades into OHLC, volume and VWAP', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(10, 100));
    store.applyTrade(trade(12, 300));
    store.applyTrade(trade(9, 100));

    const s = store.get('ABC')!;
    expect(s).toMatchObject({ open: 10, high: 12, low: 9, last: 9, volume: 500, tradeCount: 3 });
    expect(s.vwap).toBeCloseTo((10 * 100 + 12 * 300 + 9 * 100) / 500);
  });

  it('ignores zero-size or zero-price prints', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(10, 0));
    store.applyTrade(trade(0, 100));
    expect(store.get('ABC')).toBeUndefined();
  });

  it('computes change % once prev close is known', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(11, 100));
    expect(store.get('ABC')!.changePct).toBeNull();
    store.setPrevClose('ABC', 10);
    expect(store.get('ABC')!.changePct).toBeCloseTo(10);
  });

  it('drains each changed symbol once, as a copy', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(10, 100));
    store.applyTrade(trade(11, 100));
    store.applyQuote({ symbol: 'XYZ', bidPrice: 1, bidSize: 1, askPrice: 1.01, askSize: 1, timestamp: 1 });

    const drained = store.drainDirty();
    expect(drained.map((s) => s.symbol).sort()).toEqual(['ABC', 'XYZ']);
    expect(store.drainDirty()).toEqual([]);

    drained[0]!.last = 999;
    expect(store.get(drained[0]!.symbol)!.last).not.toBe(999);
  });

  it('replaces updated bars and caps the bar buffer', () => {
    const store = new SymbolStore({ maxBars: 3 });
    const bar = (t: number, close: number) => ({
      symbol: 'ABC', open: 1, high: 1, low: 1, close, volume: 1, timestamp: t,
    });
    store.applyBar(bar(1, 1));
    store.applyBar(bar(1, 2)); // correction of the same minute
    store.applyBar(bar(2, 3));
    store.applyBar(bar(3, 4));
    store.applyBar(bar(4, 5));

    const bars = store.getBars('ABC');
    expect(bars.map((b) => b.timestamp)).toEqual([2, 3, 4]);
    expect(store.getBars('ABC')[0]!.close).toBe(3);
  });

  it('computes gap % and time-of-day adjusted RVOL', () => {
    const store = new SymbolStore({ sessionFraction: () => 0.5 });
    store.applySeed({ symbol: 'ABC', prevClose: 10, open: 11, high: 11, low: 11, last: 11, volume: 500, vwap: 11 });
    store.applyReference({ symbol: 'ABC', avgVolume: 1000, floatShares: 5e6 });

    const s = store.get('ABC')!;
    expect(s.gapPct).toBeCloseTo(10);
    // 500 traded vs 1000 × 0.5 expected by now → 1.0
    expect(s.rvol).toBeCloseTo(1);
    store.applyTrade(trade(11, 500));
    expect(store.get('ABC')!.rvol).toBeCloseTo(2);
    expect(store.get('ABC')!.vwap).toBeCloseTo(11);
  });

  it('tracks 1m / 5m momentum from per-second samples', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(10, 100));
    for (let i = 0; i < 240; i++) store.sampleMomentum(); // 4 min at $10
    store.applyTrade(trade(10.5, 100));
    for (let i = 0; i < 61; i++) store.sampleMomentum(); // 1 min at $10.50
    store.applyTrade(trade(11, 100));

    const s = store.get('ABC')!;
    expect(s.chg1mPct).toBeCloseTo((11 / 10.5 - 1) * 100); // vs 60s ago
    expect(s.chg5mPct).toBeCloseTo(10); // vs oldest sample (5 min ago)
  });

  it('marks halted symbols dirty only on change', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(10, 100));
    store.drainDirty();
    store.setHalted('ABC', true);
    store.setHalted('ABC', true);
    expect(store.drainDirty()).toHaveLength(1);
    expect(store.get('ABC')!.halted).toBe(true);
  });

  it('books pre-market and after-hours prints separately from the regular session', () => {
    // Timestamps stand in for sessions: <100 pre, 100–199 regular, ≥200 post.
    const store = new SymbolStore({ sessionOf: (ts) => (ts < 100 ? 'pre' : ts < 200 ? 'regular' : 'post') });
    store.setPrevClose('ABC', 10);
    store.applyTrade(trade(11, 500, 1));
    store.applyTrade(trade(12, 500, 2));
    let s = store.get('ABC')!;
    expect(s).toMatchObject({ preVolume: 1000, preHigh: 12, preLow: 11, preLast: 12, last: 12, open: null, volume: 0 });
    expect(s.preChangePct).toBeCloseTo(20);
    expect(s.changePct).toBeCloseTo(20);

    store.applyTrade(trade(13, 100, 150));
    store.applyTrade(trade(15, 100, 199));
    store.applyTrade(trade(16.5, 300, 250));
    s = store.get('ABC')!;
    expect(s).toMatchObject({ open: 13, high: 15, volume: 200, regularClose: 15, postVolume: 300, postHigh: 16.5, last: 16.5 });
    expect(s.postChangePct).toBeCloseTo(10);
    expect(s.changePct).toBeCloseTo(65);
  });

  it('builds 1-minute bars from trades, tagged with their session', () => {
    const store = new SymbolStore({ sessionOf: (ts) => (ts < 120_000 ? 'pre' : 'regular') });
    store.applyTrade(trade(10, 100, 60_000));
    store.applyTrade(trade(11, 200, 90_000));
    store.applyTrade(trade(9.5, 100, 119_999));
    store.applyTrade(trade(12, 300, 125_000));
    store.applyTrade(trade(10.8, 50, 100_000)); // late print for a closed minute

    expect(store.getBars('ABC')).toEqual([
      { symbol: 'ABC', open: 10, high: 11, low: 9.5, close: 9.5, volume: 400, tradeCount: 3, timestamp: 60_000, session: 'pre' },
      { symbol: 'ABC', open: 12, high: 12, low: 12, close: 12, volume: 300, tradeCount: 1, timestamp: 120_000, session: 'regular' },
    ]);
  });

  it('resetSession rolls last price into prevClose', () => {
    const store = new SymbolStore();
    store.applyTrade(trade(20, 100));
    store.resetSession();
    expect(store.get('ABC')).toMatchObject({ prevClose: 20, volume: 0, last: null, high: null });
  });
});
