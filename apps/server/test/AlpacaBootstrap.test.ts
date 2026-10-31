import { describe, expect, it } from 'vitest';
import type { Bar, ReferenceData, SessionSeed } from '@deltascan/shared';
import { AlpacaRest, type AlpacaRawBar, type AlpacaRawSnapshot } from '../src/ingestion/providers/alpaca/AlpacaRest';
import { avgDailyVolume, isCommonStock, prevCloseOf, runBootstrap, seedFrom, toBar } from '../src/ingestion/providers/alpaca/bootstrap';

// Friday 2026-10-30, 10:15 ET (EDT, UTC-4).
const NOW = Date.parse('2026-10-30T14:15:00Z');
const raw = (t: string, o: number, h: number, l: number, c: number, v: number, vw?: number): AlpacaRawBar => ({ t, o, h, l, c, v, vw });

const MINUTES: AlpacaRawBar[] = [
  raw('2026-10-29T19:59:00Z', 2.0, 2.01, 1.99, 2.0, 5000), // yesterday 15:59 ET
  raw('2026-10-30T12:00:00Z', 2.4, 2.9, 2.4, 2.8, 20_000), // 08:00 ET pre-market
  raw('2026-10-30T13:00:00Z', 2.8, 3.1, 2.7, 3.0, 30_000), // 09:00 ET pre-market
  raw('2026-10-30T13:30:00Z', 3.0, 3.3, 2.95, 3.2, 100_000, 3.15), // 09:30 ET open
  raw('2026-10-30T13:31:00Z', 3.2, 3.25, 3.0, 3.05, 50_000, 3.1),
  raw('2026-10-30T14:14:00Z', 3.05, 3.08, 2.9, 2.95, 10_000), // no vw: typical price
];

describe('Alpaca bootstrap', () => {
  it("takes yesterday's close from the right daily bar, before and after today has one", () => {
    const withToday: AlpacaRawSnapshot = { dailyBar: raw('2026-10-30T04:00:00Z', 2.4, 3.3, 2.4, 2.95, 1), prevDailyBar: raw('2026-10-29T04:00:00Z', 1.9, 2.1, 1.9, 2.0, 1) };
    expect(prevCloseOf(withToday, NOW)).toBe(2.0);
    // Pre-market, before today's daily bar exists: the latest daily bar is yesterday's.
    const beforeToday: AlpacaRawSnapshot = { dailyBar: raw('2026-10-29T04:00:00Z', 1.9, 2.1, 1.9, 2.0, 1), prevDailyBar: raw('2026-10-28T04:00:00Z', 1.8, 1.9, 1.8, 1.85, 1) };
    expect(prevCloseOf(beforeToday, NOW)).toBe(2.0);
    expect(prevCloseOf({}, NOW)).toBeNull();
  });

  it("builds today's session from today's minute bars only, keeping pre-market out of the regular session", () => {
    const bars = MINUTES.map((b) => toBar('RUN', b));
    expect(bars.map((b) => b.session)).toEqual(['regular', 'pre', 'pre', 'regular', 'regular', 'regular']);
    const seed = seedFrom('RUN', 2.0, bars, 2.96, NOW);
    expect(seed).toMatchObject({
      symbol: 'RUN',
      prevClose: 2.0,
      open: 3.0,
      high: 3.3,
      low: 2.9,
      last: 2.96,
      volume: 160_000,
      pre: { volume: 50_000, high: 3.1, low: 2.4, last: 3.0 },
    });
    // VWAP weights each bar's own vwap (typical price when Alpaca leaves it out).
    const typical = (3.08 + 2.9 + 2.95) / 3;
    expect(seed.vwap).toBeCloseTo((3.15 * 100_000 + 3.1 * 50_000 + typical * 10_000) / 160_000, 10);
    expect(seed.post).toBeUndefined();
    expect(seed.close).toBeUndefined();
  });

  it('seeds a pre-market-only day with no regular open yet', () => {
    const preOnly = MINUTES.slice(0, 3).map((b) => toBar('RUN', b));
    const seed = seedFrom('RUN', 2.0, preOnly, null, Date.parse('2026-10-30T13:15:00Z'));
    expect(seed).toMatchObject({ open: null, high: null, low: null, volume: 0, vwap: null, last: 3.0, pre: { high: 3.1 } });
  });

  it('averages full-day volume over past sessions, leaving today out', () => {
    const daily = [
      raw('2026-10-27T04:00:00Z', 1, 1, 1, 1, 1_000_000),
      raw('2026-10-28T04:00:00Z', 1, 1, 1, 1, 3_000_000),
      raw('2026-10-29T04:00:00Z', 1, 1, 1, 1, 2_000_000),
      raw('2026-10-30T04:00:00Z', 1, 1, 1, 1, 9_000_000), // today, still forming
    ];
    expect(avgDailyVolume(daily, NOW)).toBe(2_000_000);
    expect(avgDailyVolume(daily, NOW, 2)).toBe(2_500_000);
    expect(avgDailyVolume([], NOW)).toBeNull();
  });

  it('emits history, a seed and the volume baseline per symbol, skipping ones Alpaca does not know', async () => {
    const rest = {
      snapshots: async () => ({ RUN: { dailyBar: raw('2026-10-30T04:00:00Z', 2.4, 3.3, 2.4, 2.95, 1), prevDailyBar: raw('2026-10-29T04:00:00Z', 1, 2, 1, 2.0, 1), latestTrade: { p: 2.96, t: '2026-10-30T14:14:59Z' } } }),
      bars: async (_s: readonly string[], timeframe: string) =>
        timeframe === '1Min' ? { RUN: MINUTES } : { RUN: [raw('2026-10-29T04:00:00Z', 1, 1, 1, 1, 4_000_000)] },
    } as unknown as AlpacaRest;
    const got: { history: [string, Bar[]][]; seed: SessionSeed[]; reference: ReferenceData[] } = { history: [], seed: [], reference: [] };
    const seeded = await runBootstrap(rest, ['RUN', 'NOPE'], NOW, {
      history: (s, b) => got.history.push([s, b]),
      seed: (s) => got.seed.push(s),
      reference: (r) => got.reference.push(r),
    });
    expect(seeded).toEqual(['RUN']);
    expect(got.history.map(([s, b]) => [s, b.length])).toEqual([['RUN', 6]]);
    expect(got.seed[0]).toMatchObject({ symbol: 'RUN', prevClose: 2.0, last: 2.96, open: 3.0 });
    expect(got.reference).toEqual([{ symbol: 'RUN', avgVolume: 4_000_000 }]);
  });
});

describe('movers filter', () => {
  it('keeps common stock and drops the warrants, rights and units that crowd the gainers list', () => {
    // From a real gainers list (2026-10-30).
    const list = ['ONEG', 'CHOW', 'SLGB', 'BTBDW', 'PECEW', 'CRANR', 'KCHVR', 'OYSER', 'GDYN', 'FMC', 'F', 'BRK.B', 'ABCDU', 'GOOGL'];
    expect(list.filter(isCommonStock)).toEqual(['ONEG', 'CHOW', 'SLGB', 'GDYN', 'FMC', 'F', 'BRK.B', 'GOOGL']);
    expect(isCommonStock('abc')).toBe(false);
    expect(isCommonStock('TOOLONG')).toBe(false);
  });
});

describe('AlpacaRest', () => {
  function fakeFetch(respond: (url: URL) => unknown, status = 200) {
    const calls: { url: URL; headers: Record<string, string> }[] = [];
    const fn = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, headers: init?.headers as Record<string, string> });
      const body = respond(url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const client = (fn: typeof fetch) => new AlpacaRest({ keyId: 'K', secretKey: 'S', feed: 'iex', sandbox: false, fetch: fn });

  it('sends the keys and feed, and splits long symbol lists into several requests', async () => {
    const symbols = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const { fn, calls } = fakeFetch((url) => Object.fromEntries((url.searchParams.get('symbols') ?? '').split(',').map((s) => [s, s === 'S7' ? null : { latestTrade: { p: 1, t: '' } }])));
    const snaps = await client(fn).snapshots(symbols);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://data.alpaca.markets/v2/stocks/snapshots');
    expect(calls[0]!.url.searchParams.get('feed')).toBe('iex');
    expect(calls[0]!.headers).toEqual({ 'APCA-API-KEY-ID': 'K', 'APCA-API-SECRET-KEY': 'S' });
    expect(Object.keys(snaps)).toHaveLength(149); // S7 came back null
  });

  it('follows next_page_token and merges each symbol across pages', async () => {
    const pages: Record<string, unknown> = {
      first: { bars: { A: [raw('2026-10-30T13:30:00Z', 1, 1, 1, 1, 1)], B: [raw('2026-10-30T13:30:00Z', 2, 2, 2, 2, 1)] }, next_page_token: 'p2' },
      p2: { bars: { B: [raw('2026-10-30T13:31:00Z', 2, 2, 2, 2, 1)] }, next_page_token: null },
    };
    const { fn, calls } = fakeFetch((url) => pages[url.searchParams.get('page_token') ?? 'first']);
    const bars = await client(fn).bars(['A', 'B'], '1Min', new Date(NOW));
    expect(calls.map((c) => c.url.searchParams.get('page_token'))).toEqual([null, 'p2']);
    expect(calls[0]!.url.searchParams.get('timeframe')).toBe('1Min');
    expect(calls[0]!.url.searchParams.get('sort')).toBe('asc');
    expect(Object.fromEntries(Object.entries(bars).map(([s, l]) => [s, l.length]))).toEqual({ A: 1, B: 2 });
  });

  it('reads the top gainers and reports HTTP errors with their status', async () => {
    const { fn } = fakeFetch(() => ({ gainers: [{ symbol: 'RUN' }, { symbol: 'GAP' }], losers: [] }));
    expect(await client(fn).topGainers(20)).toEqual(['RUN', 'GAP']);
    const failing = fakeFetch(() => ({ message: 'forbidden' }), 403);
    await expect(client(failing.fn).topGainers(20)).rejects.toThrow('403');
  });
});
