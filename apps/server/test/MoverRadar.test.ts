import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar, Trade } from '@deltascan/shared';
import { MoverRadar, barPrints, planLive } from '../src/ingestion/providers/alpaca/MoverRadar';
import { AlpacaStreamProvider } from '../src/ingestion/providers/alpaca/AlpacaStreamProvider';
import type { AlpacaRest } from '../src/ingestion/providers/alpaca/AlpacaRest';
import { pino } from 'pino';

// Friday 2026-10-30, 10:00 ET.
const T0 = Date.parse('2026-10-30T14:00:00Z');
const MIN = 60_000;
const bar = (symbol: string, minute: number, open: number, close: number, volume = 10_000): Bar => ({
  symbol,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume,
  timestamp: T0 + minute * MIN,
});
/** The time just after `minute`'s bar completed. */
const after = (minute: number) => T0 + (minute + 1) * MIN + 2_000;

describe('MoverRadar', () => {
  it('measures the move over the last 5 minutes from the close before them', () => {
    const radar = new MoverRadar();
    radar.onBar(bar('RUN', 0, 2.0, 2.0)); // before the window: the base
    for (let m = 1; m <= 5; m++) radar.onBar(bar('RUN', m, 2 + (m - 1) * 0.04, 2 + m * 0.04));
    expect(radar.move('RUN', after(5))).toBeCloseTo(10, 6); // 2.00 → 2.20
    expect(radar.candidates(after(5))).toEqual([{ symbol: 'RUN', movePct: expect.closeTo(10, 6) }]);
  });

  it('counts falls too, and ignores small or thin moves', () => {
    const radar = new MoverRadar();
    radar.onBar(bar('DUMP', 0, 5, 4.5)); // first bar seen: the move starts at its open
    radar.onBar(bar('FLAT', 0, 3, 3.06)); // +2%
    radar.onBar(bar('THIN', 0, 1, 1.2, 100)); // +20% on $120
    expect(radar.candidates(after(0)).map((c) => [c.symbol, Math.round(c.movePct)])).toEqual([['DUMP', -10]]);
  });

  it('forgets a move once the stock goes quiet', () => {
    const radar = new MoverRadar();
    radar.onBar(bar('RUN', 0, 2, 2.2));
    expect(radar.heat('RUN', after(0))).toBeCloseTo(10, 6);
    expect(radar.heat('RUN', after(6))).toBe(0);
    expect(radar.candidates(after(40))).toEqual([]);
    expect(radar.size).toBe(0);
  });
});

describe('planLive', () => {
  const base = { pinned: new Set(['SPY']), minLiveMs: 2 * MIN, swapMargin: 2 };
  const heats: Record<string, number> = { HOT: 12, WARM: 6, COLD: 1, OLD: 0.5 };
  const heat = (s: string) => heats[s] ?? 0;

  it('fills free slots with the hottest waiting symbols', () => {
    const live = new Map([['SPY', 0]]);
    expect(planLive({ ...base, live, tracked: ['COLD', 'HOT', 'WARM'], slots: 3, heat, now: T0 })).toEqual({ add: ['HOT', 'WARM'], drop: [] });
  });

  it('when full, swaps out the coldest symbol that has had its slot long enough, never a pinned one', () => {
    const live = new Map([
      ['SPY', 0],
      ['OLD', T0 - 10 * MIN],
      ['COLD', T0 - 30_000], // only just went live: keeps its slot for now
    ]);
    expect(planLive({ ...base, live, tracked: ['HOT', 'WARM'], slots: 3, heat, now: T0 })).toEqual({ add: ['HOT'], drop: ['OLD'] });
  });

  it('does not swap for a symbol that is only slightly hotter', () => {
    const live = new Map([['SPY', 0], ['WARM', 0]]);
    expect(planLive({ ...base, live, tracked: ['SEVEN'], slots: 2, heat: (s) => (s === 'SEVEN' ? 7 : heat(s)), now: T0 })).toEqual({ add: [], drop: [] });
  });
});

describe('barPrints', () => {
  it('replays a bar as open, low, high, close for an up bar, with the volume split', () => {
    const prints = barPrints({ ...bar('RUN', 0, 2, 2.2, 1_000), high: 2.3, low: 1.9 });
    expect(prints.map((p) => [p.price, p.size, p.timestamp - T0])).toEqual([
      [2, 250, 0],
      [1.9, 250, 15_000],
      [2.3, 250, 30_000],
      [2.2, 250, 59_000],
    ]);
    const down = barPrints({ ...bar('RUN', 0, 2.2, 2, 1_000), high: 2.3, low: 1.9 });
    expect(down.map((p) => p.price)).toEqual([2.2, 2.3, 1.9, 2]);
  });
});

describe('AlpacaStreamProvider with the radar', () => {
  afterEach(() => vi.useRealTimers());

  function setup(slots: number) {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const rest = {
      snapshots: async () => ({}),
      bars: async () => ({}),
      topGainers: async () => [] as string[],
    } as unknown as AlpacaRest;
    const provider = new AlpacaStreamProvider({
      keyId: 'K',
      secretKey: 'S',
      feed: 'iex',
      sandbox: false,
      statuses: false,
      quotes: false,
      logger: pino({ level: 'silent' }),
      heartbeatIntervalMs: 1e9,
      heartbeatTimeoutMs: 1e9,
      reconnectBaseMs: 1e9,
      reconnectMaxMs: 1e9,
      rest,
      movers: { top: 20, refreshMs: 1e9, maxSymbols: slots },
      radar: { minMovePct: 4, windowMs: 5 * MIN, minNotional: 5_000 },
    });
    const sent: Record<string, unknown>[] = [];
    // Drive the protocol by hand instead of over a socket.
    const internals = provider as unknown as { socket: { send: (m: object) => void }; handleRaw: (d: Buffer) => void };
    internals.socket.send = (m) => sent.push(m as Record<string, unknown>);
    const feed = (...msgs: object[]) => internals.handleRaw(Buffer.from(JSON.stringify(msgs)));
    const streamBar = (b: Bar) =>
      feed({ T: 'b', S: b.symbol, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, t: new Date(b.timestamp).toISOString() });
    const trades: Trade[] = [];
    const bars: Bar[] = [];
    provider.on('trade', (t) => trades.push(t));
    provider.on('bar', (b) => bars.push(b));
    provider.subscribe(['SPY']);
    feed({ T: 'success', msg: 'authenticated' });
    return { provider, sent, feed, streamBar, trades, bars };
  }

  it('streams every symbol’s bars, picks up a stock that starts running and gives it a live slot', async () => {
    const { provider, sent, streamBar, bars } = setup(3);
    expect(sent).toEqual([
      { action: 'subscribe', trades: ['SPY'] },
      { action: 'subscribe', bars: ['*'] },
    ]);
    streamBar(bar('ZZZ', 0, 1, 1.01)); // quiet: no row
    streamBar(bar('RUN', 0, 2, 2.2)); // +10%
    expect(bars).toEqual([]); // untracked bars never reach the store
    await vi.advanceTimersByTimeAsync(2_000);
    expect(provider.symbols).toEqual(['SPY', 'RUN']);
    expect(sent.at(-1)).toEqual({ action: 'subscribe', trades: ['RUN'] });
  });

  it('rotates a cold stock to bars only (its row keeps updating) when a hotter one needs the slot', async () => {
    const { provider, sent, streamBar, trades, bars } = setup(2);
    streamBar(bar('OLD', 0, 2, 2.2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.at(-1)).toEqual({ action: 'subscribe', trades: ['OLD'] });

    // Five minutes later OLD has gone flat and NEW is running.
    vi.setSystemTime(T0 + 6 * MIN);
    streamBar(bar('OLD', 5, 2.2, 2.2));
    streamBar(bar('NEW', 5, 3, 3.6));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(provider.symbols).toEqual(['SPY', 'OLD', 'NEW']);
    expect(sent.slice(-2)).toEqual([
      { action: 'unsubscribe', trades: ['OLD'] },
      { action: 'subscribe', trades: ['NEW'] },
    ]);

    // OLD's next bar stands in for its trades; NEW's bar doesn't (it has live trades).
    trades.length = bars.length = 0;
    streamBar(bar('OLD', 6, 2.2, 2.1));
    streamBar(bar('NEW', 6, 3.6, 3.7));
    expect(trades.map((t) => [t.symbol, t.price])).toEqual([
      ['OLD', 2.2],
      ['OLD', 2.2],
      ['OLD', 2.1],
      ['OLD', 2.1],
    ]);
    expect(bars.map((b) => b.symbol)).toEqual(['OLD', 'NEW']);
  });
});
