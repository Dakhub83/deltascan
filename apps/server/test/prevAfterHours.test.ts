import { describe, expect, it } from 'vitest';
import type { AlpacaRawBar, AlpacaRest } from '../src/ingestion/providers/alpaca/AlpacaRest';
import {
  PrevAfterHoursScanner,
  etWallTimeToUtc,
  latestCompletedAfterHours,
  refineWithMinutes,
  summarizeHourly,
  topGainers,
} from '../src/ingestion/providers/alpaca/prevAfterHours';

const raw = (t: string, c: number, v: number, h = c): AlpacaRawBar => ({ t, o: c, h, l: c, c, v });
const DAYS = [
  { date: '2026-10-29', open: '09:30', close: '16:00' },
  { date: '2026-10-30', open: '09:30', close: '16:00' },
];
// Friday 2026-10-30 close (EDT): 20:00 UTC; after hours end 00:00 UTC.
const W = { date: '2026-10-30', closeMs: Date.parse('2026-10-30T20:00:00Z'), endMs: Date.parse('2026-10-31T00:00:00Z') };

describe('after-hours window', () => {
  it('converts New York wall time in summer and winter', () => {
    expect(etWallTimeToUtc('2026-10-30', '16:00')).toBe(Date.parse('2026-10-30T20:00:00Z')); // EDT
    expect(etWallTimeToUtc('2026-11-27', '13:00')).toBe(Date.parse('2026-11-27T18:00:00Z')); // EST half day
  });

  it('picks the latest session that has ended and is 15 minutes old', () => {
    // Friday 19:00 ET: Friday's after-hours is still running, so Thursday's.
    expect(latestCompletedAfterHours(DAYS, Date.parse('2026-10-30T23:00:00Z'))?.date).toBe('2026-10-29');
    // Friday 20:10 ET: ended, but SIP isn't 15 minutes old yet.
    expect(latestCompletedAfterHours(DAYS, Date.parse('2026-10-31T00:10:00Z'))?.date).toBe('2026-10-29');
    // Saturday: Friday's.
    expect(latestCompletedAfterHours(DAYS, Date.parse('2026-10-31T15:00:00Z'))).toEqual(W);
    // A half day ends four hours after its 13:00 close.
    const half = latestCompletedAfterHours([{ date: '2026-11-27', open: '09:30', close: '13:00' }], Date.parse('2026-11-27T22:20:00Z'));
    expect(half?.endMs).toBe(Date.parse('2026-11-27T22:00:00Z'));
  });
});

describe('summarising a session', () => {
  // TSLA's real SIP hours from 2026-10-30.
  const TSLA = [
    raw('2026-10-30T19:00:00Z', 399.83, 7_150_152),
    raw('2026-10-30T20:00:00Z', 399.67, 4_718_876, 400.1),
    raw('2026-10-30T21:00:00Z', 399.48, 56_358),
    raw('2026-10-30T22:00:00Z', 399.5377, 35_394),
    raw('2026-10-30T23:00:00Z', 400.22, 66_170, 400.5),
  ];

  it('takes the close from the last regular hour and the move from the hours after', () => {
    const ah = summarizeHourly(TSLA, W)!;
    expect(ah).toMatchObject({ date: '2026-10-30', close: 399.83, last: 400.22, high: 400.5 });
    expect(ah.changePct).toBeCloseTo((400.22 / 399.83 - 1) * 100, 10);
    // The first hour after the close still holds the closing auction, hence the refine step.
    expect(ah.volume).toBe(4_718_876 + 56_358 + 35_394 + 66_170);
    expect(summarizeHourly(TSLA.slice(0, 1), W)).toBeNull(); // no after-hours trades
    expect(summarizeHourly(TSLA.slice(1), W)).toBeNull(); // no close
  });

  it('refines with minute bars, leaving out the closing-auction minute', () => {
    const rough = summarizeHourly(TSLA, W)!;
    const minutes = [
      raw('2026-10-30T20:00:00Z', 399.7, 4_500_000, 399.9), // 16:00 ET: the closing cross
      raw('2026-10-30T20:01:00Z', 400.0, 12_000, 400.3),
      raw('2026-10-30T23:59:00Z', 401.0, 3_000),
      raw('2026-10-31T00:00:00Z', 405.0, 99_999), // after the session
    ];
    const exact = refineWithMinutes(rough, minutes, W);
    expect(exact).toMatchObject({ close: 399.83, last: 401.0, high: 401.0, volume: 15_000 });
    expect(refineWithMinutes(rough, [], W).volume).toBe(0);
  });

  it('ranks the gainers that clear the move and volume bars', () => {
    const ah = (changePct: number, volume: number) => ({ date: 'd', close: 1, last: 1, high: 1, volume, changePct });
    const all = new Map([
      ['BIG', ah(40, 500_000)],
      ['THIN', ah(80, 1_000)],
      ['MID', ah(12, 50_000)],
      ['FLAT', ah(2, 900_000)],
      ['DOWN', ah(-20, 900_000)],
    ]);
    expect(topGainers(all, { minChangePct: 5, minVolume: 20_000, top: 30 })).toEqual(['BIG', 'MID']);
    expect(topGainers(all, { minChangePct: 5, minVolume: 20_000, top: 1 })).toEqual(['BIG']);
  });
});

describe('PrevAfterHoursScanner', () => {
  function fakeRest() {
    const calls: string[] = [];
    const hour = (close: number, last: number, v: number) => [raw('2026-10-30T19:00:00Z', close, 1e6), raw('2026-10-30T23:00:00Z', last, v)];
    const minute = (last: number, v: number) => [raw('2026-10-30T20:00:00Z', last, 1e6), raw('2026-10-30T22:30:00Z', last, v)];
    const rest = {
      calendar: async () => DAYS,
      assets: async () => [
        { symbol: 'RUN', exchange: 'NASDAQ', tradable: true, status: 'active' },
        { symbol: 'DUD', exchange: 'NYSE', tradable: true, status: 'active' },
        { symbol: 'PINK', exchange: 'OTC', tradable: true, status: 'active' },
        { symbol: 'RUNNW', exchange: 'NASDAQ', tradable: true, status: 'active' },
        { symbol: 'HALTD', exchange: 'NASDAQ', tradable: false, status: 'active' },
      ],
      bars: async (symbols: readonly string[], timeframe: string, _start: Date, opts: { feed?: string }) => {
        calls.push(`${timeframe} ${opts.feed} ${symbols.join(',')}`);
        const all: Record<string, AlpacaRawBar[]> =
          timeframe === '1Hour' ? { RUN: hour(2, 2.6, 400_000), DUD: hour(10, 9.9, 50_000) } : { RUN: minute(2.6, 300_000), DUD: minute(9.9, 40_000) };
        return Object.fromEntries(symbols.filter((s) => all[s]).map((s) => [s, all[s]!]));
      },
    } as unknown as AlpacaRest;
    return { rest, calls };
  }

  it('scans listed common stocks once per session, from SIP, and refines the movers', async () => {
    const { rest, calls } = fakeRest();
    const scanner = new PrevAfterHoursScanner(rest, { minChangePct: 5, minVolume: 20_000, top: 30 });
    const now = Date.parse('2026-10-31T15:00:00Z');
    expect(await scanner.refresh(now)).toEqual(['RUN']);
    expect(calls).toEqual(['1Hour sip RUN,DUD', '1Min sip RUN']); // OTC, warrant and untradable left out
    expect(scanner.get('RUN')).toMatchObject({ date: '2026-10-30', close: 2, last: 2.6, volume: 300_000 });
    expect(scanner.get('RUN')!.changePct).toBeCloseTo(30, 10);

    // A symbol that wasn't a mover gets its numbers on demand.
    expect(scanner.get('DUD')).toBeUndefined();
    expect(await scanner.ensure(['DUD', 'NOPE'])).toEqual(['DUD']);
    expect(scanner.get('DUD')!.changePct).toBeCloseTo(-1, 10);

    // Same session again: nothing re-scanned.
    expect(await scanner.refresh(now + 60 * 60_000)).toBeNull();
    expect(calls).toHaveLength(3);
  });
});
