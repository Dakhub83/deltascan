import { describe, expect, it } from 'vitest';
import type { SymbolSnapshot } from '@deltascan/shared';
import { AlertEngine, type PriorState } from '../src/scanner/AlertEngine';

const snap = (over: Partial<SymbolSnapshot> = {}) =>
  ({ symbol: 'ABC', changePct: 5, vwap: 10, avgVolume: null, ...over }) as SymbolSnapshot;
const prior = (over: Partial<PriorState> = {}): PriorState => ({ high: 11, low: 9, last: 10, vwap: 10, ...over });
const trade = (price: number, size = 100, timestamp = 1_000) => ({ symbol: 'ABC', price, size, timestamp });

describe('AlertEngine', () => {
  it('fires new high once, then respects the cooldown', () => {
    const engine = new AlertEngine();
    engine.onTrade(trade(11.5, 100, 1_000), prior(), snap());
    engine.onTrade(trade(11.6, 100, 2_000), prior({ high: 11.5 }), snap());
    engine.onTrade(trade(11.7, 100, 70_000), prior({ high: 11.6 }), snap());

    const alerts = engine.drain().filter((a) => a.type === 'new_high');
    expect(alerts.map((a) => a.price)).toEqual([11.5, 11.7]);
  });

  it('detects VWAP reclaim only when crossing beyond the buffer', () => {
    const engine = new AlertEngine({ vwapCrossBuffer: 0.01 });
    engine.onTrade(trade(10.05), prior({ last: 9.9 }), snap({ vwap: 10 }));
    expect(engine.drain()).toEqual([]);
    engine.onTrade(trade(10.2), prior({ last: 9.9 }), snap({ vwap: 10 }));
    expect(engine.drain().map((a) => a.type)).toEqual(['vwap_reclaim']);
  });

  it('flags block trades by size and notional', () => {
    const engine = new AlertEngine();
    engine.onTrade(trade(10, 15_000), prior(), snap()); // $150K — below notional
    engine.onTrade(trade(20, 15_000), prior({ high: 25 }), snap());
    const blocks = engine.drain().filter((a) => a.type === 'block_trade');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.detail).toContain('15,000 sh');
  });

  it('fires a volume spike against the per-minute average', () => {
    const engine = new AlertEngine({ volumeSpikeMultiple: 5 });
    // avg 390k/day → 1k/min expected; 6k in one minute = 6×
    const s = snap({ avgVolume: 390_000 });
    for (let i = 0; i < 6; i++) engine.onTrade(trade(10, 1_000, 1_000 + i * 1_000), prior({ high: 99 }), s);
    expect(engine.drain().filter((a) => a.type === 'volume_spike')).toHaveLength(1);
  });

  it('measures volume spikes against today\'s pace when the stock is already in play', () => {
    const engine = new AlertEngine({ volumeSpikeMultiple: 5 });
    // RVOL 3 → baseline 3k/min; 6k in a minute is only 2× → no alert
    const s = snap({ avgVolume: 390_000, rvol: 3 });
    for (let i = 0; i < 6; i++) engine.onTrade(trade(10, 1_000, 1_000 + i * 1_000), prior({ high: 99 }), s);
    expect(engine.drain().filter((a) => a.type === 'volume_spike')).toHaveLength(0);
  });
});
