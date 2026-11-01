/**
 * Alpaca Market Data REST (v2 stocks + v1beta1 screener), for the startup bootstrap and the
 * movers list. Same keys as the stream.
 * Docs: https://docs.alpaca.markets/reference/stocksnapshots
 */

export interface AlpacaRawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

export interface AlpacaRawSnapshot {
  latestTrade?: { p: number; t: string };
  dailyBar?: AlpacaRawBar;
  prevDailyBar?: AlpacaRawBar;
}

/** A trading day; `open` / `close` are ET wall-clock times ("09:30", "16:00", "13:00" on half days). */
export interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
}

export interface AlpacaAsset {
  symbol: string;
  exchange: string;
  tradable: boolean;
  status: string;
}

export interface AlpacaRestOptions {
  keyId: string;
  secretKey: string;
  feed: 'iex' | 'sip';
  sandbox: boolean;
  /** Paper account: the trading API (calendar, assets) is at paper-api. */
  paper?: boolean;
  /** Pause between requests in long scans, to stay under the plan's rate limit (200/min on free). */
  pauseMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** Long symbol lists go in the query string; this keeps the URL well under limits. */
const SYMBOLS_PER_REQUEST = 100;
const BARS_PAGE_LIMIT = 10_000;
/** A bars request that keeps paging past this is cut off rather than looping forever. */
const MAX_PAGES = 50;

export class AlpacaRest {
  private readonly base: string;
  private readonly tradingBase: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: AlpacaRestOptions) {
    this.base = opts.sandbox ? 'https://data.sandbox.alpaca.markets' : 'https://data.alpaca.markets';
    this.tradingBase = opts.paper === false ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    this.fetch = opts.fetch ?? fetch;
  }

  /** Trading days between two ET dates (YYYY-MM-DD), with half-day closes. */
  async calendar(start: string, end: string): Promise<AlpacaCalendarDay[]> {
    return this.get<AlpacaCalendarDay[]>('/v2/calendar', { start, end }, this.tradingBase);
  }

  /** Every active US equity Alpaca knows (OTC included; filter on `exchange`). */
  async assets(): Promise<AlpacaAsset[]> {
    return this.get<AlpacaAsset[]>('/v2/assets', { status: 'active', asset_class: 'us_equity' }, this.tradingBase);
  }

  /** Latest trade, today's and the previous daily bar, keyed by symbol. Unknown symbols are absent. */
  async snapshots(symbols: readonly string[]): Promise<Record<string, AlpacaRawSnapshot>> {
    const out: Record<string, AlpacaRawSnapshot> = {};
    for (const chunk of chunks(symbols, SYMBOLS_PER_REQUEST)) {
      const body = await this.get<Record<string, AlpacaRawSnapshot | null>>('/v2/stocks/snapshots', {
        symbols: chunk.join(','),
        feed: this.opts.feed,
      });
      for (const [symbol, snap] of Object.entries(body)) if (snap) out[symbol] = snap;
    }
    return out;
  }

  /**
   * Bars since `start`, oldest first, keyed by symbol; follows `next_page_token`. `feed: 'sip'`
   * works on the free plan for data older than 15 minutes (the whole market, not just IEX).
   */
  async bars(
    symbols: readonly string[],
    timeframe: '1Min' | '1Hour' | '1Day',
    start: Date,
    opts: { end?: Date; feed?: 'iex' | 'sip' } = {},
  ): Promise<Record<string, AlpacaRawBar[]>> {
    const out: Record<string, AlpacaRawBar[]> = {};
    let first = true;
    for (const chunk of chunks(symbols, SYMBOLS_PER_REQUEST)) {
      if (!first && this.opts.pauseMs) await new Promise((r) => setTimeout(r, this.opts.pauseMs));
      first = false;
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body: { bars?: Record<string, AlpacaRawBar[]> | null; next_page_token?: string | null } = await this.get('/v2/stocks/bars', {
          symbols: chunk.join(','),
          timeframe,
          start: start.toISOString(),
          ...(opts.end ? { end: opts.end.toISOString() } : {}),
          limit: String(BARS_PAGE_LIMIT),
          feed: opts.feed ?? this.opts.feed,
          adjustment: 'raw',
          sort: 'asc',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        for (const [symbol, list] of Object.entries(body.bars ?? {})) (out[symbol] ??= []).push(...list);
        pageToken = body.next_page_token ?? null;
        if (!pageToken) break;
      }
    }
    return out;
  }

  /** Today's top % gainers across the market. */
  async topGainers(top: number): Promise<string[]> {
    const body = await this.get<{ gainers?: { symbol: string }[] }>('/v1beta1/screener/stocks/movers', { top: String(top) });
    return (body.gainers ?? []).map((g) => g.symbol);
  }

  private async get<T>(path: string, query: Record<string, string>, base = this.base): Promise<T> {
    const url = `${base}${path}?${new URLSearchParams(query)}`;
    const res = await this.fetch(url, {
      headers: { 'APCA-API-KEY-ID': this.opts.keyId, 'APCA-API-SECRET-KEY': this.opts.secretKey },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Alpaca ${path} ${res.status}: keys rejected or not allowed on this plan (check ALPACA_KEY_ID / ALPACA_SECRET_KEY / ALPACA_FEED)`);
    }
    if (!res.ok) throw new Error(`Alpaca ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

function* chunks<T>(list: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}
