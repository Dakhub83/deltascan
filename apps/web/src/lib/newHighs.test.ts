import { describe, expect, it } from 'vitest';
import type { Alert, AlertType, SymbolSnapshot } from '@deltascan/shared';
import { fmtAgo, isQuiet, lastNhodBySymbol, nhodLeaders, nhodRows, passesNhodFilter } from './newHighs';

// Friday 2026-10-30, 10:00 ET.
const T0 = Date.parse('2026-10-30T14:00:00Z');
const MIN = 60_000;
let seq = 0;
const alert = (symbol: string, minute: number, type: AlertType = 'new_high', price = 2): Alert => ({
  id: `a${seq++}`,
  type,
  symbol,
  price,
  detail: '',
  changePct: 50,
  timestamp: T0 + minute * MIN,
});
/** The feed is newest first. */
const feed = (...alerts: Alert[]) => alerts.sort((a, b) => b.timestamp - a.timestamp);

describe('nhodRows', () => {
  it('numbers each NHOD per symbol and counts repeats in the trailing 10 minutes, ignoring other alert types', () => {
    const rows = nhodRows(feed(alert('RUN', 0), alert('RUN', 2), alert('RUN', 4, 'topping'), alert('GAP', 5), alert('RUN', 11), alert('RUN', 12)));
    expect(rows.map((r) => [r.symbol, r.nth, r.recent])).toEqual([
      ['RUN', 4, 2], // minute 12: 11 and 12 (minute 2 is exactly 10 min back, out)
      ['RUN', 3, 2], // minute 11: 2 and 11
      ['GAP', 1, 1],
      ['RUN', 2, 2],
      ['RUN', 1, 1],
    ]);
  });

  it('starts the count over on a new ET day', () => {
    const yesterday = alert('RUN', -24 * 60);
    const rows = nhodRows(feed(yesterday, alert('RUN', 0)));
    expect(rows.map((r) => r.nth)).toEqual([1, 1]);
  });
});

describe('nhodLeaders', () => {
  it('keeps one row per symbol, most NHODs in the last 10 minutes first', () => {
    const rows = nhodRows(feed(alert('OLD', -30), alert('OLD', -29), alert('OLD', -28), alert('HOT', 0), alert('HOT', 1), alert('ONE', 2)));
    const leaders = nhodLeaders(rows, T0 + 3 * MIN);
    expect(leaders.map((r) => [r.symbol, r.recent, r.nth])).toEqual([
      ['HOT', 2, 2],
      ['ONE', 1, 1],
      ['OLD', 0, 3],
    ]);
  });
});

describe('quiet and filters', () => {
  it('flags a stock that pushed and then stalled, not a single new high', () => {
    const rows = nhodRows(feed(alert('RUN', 0), alert('RUN', 1), alert('ONE', 0)));
    const last = lastNhodBySymbol(rows);
    const run = last.get('RUN')!;
    expect([run.timestamp, run.nth]).toEqual([T0 + MIN, 2]);
    expect(isQuiet(run.nth, run.timestamp, T0 + 3 * MIN)).toBe(false);
    expect(isQuiet(run.nth, run.timestamp, T0 + 4 * MIN)).toBe(true);
    const one = last.get('ONE')!;
    expect(isQuiet(one.nth, one.timestamp, T0 + 30 * MIN)).toBe(false);
  });

  it('filters on the live price, float and RVOL, and on repeats', () => {
    const [row] = nhodRows(feed(alert('RUN', 0, 'new_high', 2)));
    const snap = { symbol: 'RUN', last: 3, rvol: 4, floatShares: 2e6 } as SymbolSnapshot;
    expect(passesNhodFilter(row!, snap, {})).toBe(true);
    expect(passesNhodFilter(row!, snap, { priceRange: { min: null, max: 2.5 } })).toBe(false); // live $3, not the $2 alert
    expect(passesNhodFilter(row!, snap, { floatRange: { min: null, max: 1e6 } })).toBe(false);
    expect(passesNhodFilter(row!, { ...snap, floatShares: null }, { floatRange: { min: null, max: 1e6 } })).toBe(true);
    expect(passesNhodFilter(row!, snap, { minRvol: 5 })).toBe(false);
    expect(passesNhodFilter(row!, undefined, { minRvol: 2 })).toBe(false);
    expect(passesNhodFilter(row!, snap, { minRepeats: 2 })).toBe(false);
  });

  it('formats elapsed time', () => {
    expect([fmtAgo(42_000), fmtAgo(5 * MIN), fmtAgo(330_000), fmtAgo(66 * MIN)]).toEqual(['42s', '5m', '5m 30s', '1h 6m']);
  });
});
