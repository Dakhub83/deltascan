import type { PrevAfterHours } from '@deltascan/shared';
import type { AlpacaCalendarDay, AlpacaRawBar, AlpacaRest } from './AlpacaRest';
import { isCommonStock } from './bootstrap';
import { parseAlpacaTimestamp } from './messages';

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
/** Extended hours run four hours past the close (16:00–20:00, or 13:00–17:00 on half days). */
const AFTER_HOURS_MS = 4 * HOUR;
/** The free plan serves full-market (SIP) data once it is 15 minutes old. */
const SIP_DELAY_MS = 15 * MINUTE;
/** Listed exchanges; OTC names aren't in the live feed anyway. */
const LISTED = new Set(['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS']);

export interface PrevAfterHoursOptions {
  /** Movers this far up after the close (vs the 4 PM price) are candidates. */
  minChangePct: number;
  /** Shares traded after the close, so one odd print doesn't make a mover. */
  minVolume: number;
  /** How many of the biggest gainers become scanner rows. */
  top: number;
}

export const DEFAULT_PREV_AH: PrevAfterHoursOptions = { minChangePct: 5, minVolume: 20_000, top: 30 };

const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });

/** "2026-10-30" + "16:00" in New York → epoch ms. */
export function etWallTimeToUtc(date: string, hhmm: string): number {
  const naive = Date.parse(`${date}T${hhmm}:00Z`);
  const name = offsetFormat.formatToParts(naive).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name);
  const offsetMin = m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : -300;
  return naive - offsetMin * MINUTE;
}

export interface AfterHoursWindow {
  date: string;
  closeMs: number;
  endMs: number;
}

/** The most recent trading day whose after-hours session has ended (and is old enough for SIP). */
export function latestCompletedAfterHours(days: readonly AlpacaCalendarDay[], now: number): AfterHoursWindow | null {
  for (const day of [...days].sort((a, b) => b.date.localeCompare(a.date))) {
    const closeMs = etWallTimeToUtc(day.date, day.close);
    const endMs = closeMs + AFTER_HOURS_MS;
    if (endMs + SIP_DELAY_MS <= now) return { date: day.date, closeMs, endMs };
  }
  return null;
}

/**
 * From hourly bars spanning the last regular hour and the session after it: the close and the
 * after-hours move. The volume is rough (the hour after the close holds the closing-auction
 * prints); `refineWithMinutes` corrects it.
 */
export function summarizeHourly(bars: readonly AlpacaRawBar[], w: AfterHoursWindow): PrevAfterHours | null {
  let close: number | null = null;
  const after: AlpacaRawBar[] = [];
  for (const b of bars) {
    const t = parseAlpacaTimestamp(b.t);
    if (t < w.closeMs) close = b.c;
    else if (t < w.endMs) after.push(b);
  }
  if (close === null || !(close > 0) || !after.length) return null;
  const last = after[after.length - 1]!.c;
  return {
    date: w.date,
    close,
    last,
    high: Math.max(...after.map((b) => b.h)),
    volume: after.reduce((sum, b) => sum + b.v, 0),
    changePct: (last / close - 1) * 100,
  };
}

/**
 * Exact after-hours numbers from minute bars, leaving out the close's own minute: its prints are
 * the closing auction, not after-hours trading. Keeps the hourly close (the 4 PM reference).
 */
export function refineWithMinutes(rough: PrevAfterHours, bars: readonly AlpacaRawBar[], w: AfterHoursWindow): PrevAfterHours {
  const after = bars.filter((b) => {
    const t = parseAlpacaTimestamp(b.t);
    return t >= w.closeMs + MINUTE && t < w.endMs;
  });
  if (!after.length) return { ...rough, volume: 0 };
  const last = after[after.length - 1]!.c;
  return {
    ...rough,
    last,
    high: Math.max(...after.map((b) => b.h)),
    volume: after.reduce((sum, b) => sum + b.v, 0),
    changePct: (last / rough.close - 1) * 100,
  };
}

/** The biggest after-hours gainers, best first. */
export function topGainers(all: ReadonlyMap<string, PrevAfterHours>, opts: PrevAfterHoursOptions): string[] {
  return [...all]
    .filter(([, ah]) => ah.changePct >= opts.minChangePct && ah.volume >= opts.minVolume)
    .sort(([, a], [, b]) => b.changePct - a.changePct)
    .slice(0, opts.top)
    .map(([symbol]) => symbol);
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Yesterday's after-hours movers across the whole market. Once per completed session: the
 * calendar finds the session, hourly SIP bars for every listed common stock find the movers,
 * then minute bars give the real volume and high for the candidates (and any symbol asked for).
 */
export class PrevAfterHoursScanner {
  private window: AfterHoursWindow | null = null;
  private rough = new Map<string, PrevAfterHours>();
  private readonly exact = new Map<string, PrevAfterHours>();
  private running: Promise<string[] | null> | null = null;

  constructor(private readonly rest: AlpacaRest, readonly opts: PrevAfterHoursOptions = DEFAULT_PREV_AH) {}

  get date(): string | null {
    return this.window?.date ?? null;
  }

  get(symbol: string): PrevAfterHours | undefined {
    return this.exact.get(symbol);
  }

  /**
   * Scans the latest completed session if it isn't the one already scanned. Resolves to the top
   * gainers when a new scan ran, null otherwise. Concurrent calls share one scan.
   */
  refresh(now: number, alsoFor: readonly string[] = []): Promise<string[] | null> {
    this.running ??= this.scan(now, alsoFor).finally(() => (this.running = null));
    return this.running;
  }

  private async scan(now: number, alsoFor: readonly string[]): Promise<string[] | null> {
    const days = await this.rest.calendar(isoDate(now - 10 * 24 * HOUR), isoDate(now));
    const w = latestCompletedAfterHours(days, now);
    if (!w || w.date === this.window?.date) return null;

    const symbols = (await this.rest.assets())
      .filter((a) => a.tradable && LISTED.has(a.exchange) && isCommonStock(a.symbol))
      .map((a) => a.symbol);
    const hourly = await this.rest.bars(symbols, '1Hour', new Date(w.closeMs - HOUR), { end: new Date(w.endMs), feed: 'sip' });
    const rough = new Map<string, PrevAfterHours>();
    for (const [symbol, bars] of Object.entries(hourly)) {
      const ah = summarizeHourly(bars, w);
      if (ah) rough.set(symbol, ah);
    }
    // Rough volume overcounts (closing auction), so the cut here is loose; the exact pass decides.
    const candidates = [...rough]
      .filter(([, ah]) => ah.changePct >= this.opts.minChangePct && ah.volume >= this.opts.minVolume)
      .sort(([, a], [, b]) => b.changePct - a.changePct)
      .slice(0, this.opts.top * 3)
      .map(([symbol]) => symbol);

    this.window = w;
    this.rough = rough;
    this.exact.clear();
    await this.refine([...new Set([...candidates, ...alsoFor])]);
    return topGainers(this.exact, this.opts);
  }

  /** Exact numbers for symbols scanned but not refined yet; returns the ones it added. */
  async ensure(symbols: readonly string[]): Promise<string[]> {
    if (this.running) await this.running.catch(() => null);
    const missing = symbols.filter((s) => this.rough.has(s) && !this.exact.has(s));
    if (missing.length) await this.refine(missing);
    return missing.filter((s) => this.exact.has(s));
  }

  private async refine(symbols: readonly string[]): Promise<void> {
    const w = this.window;
    const wanted = symbols.filter((s) => this.rough.has(s));
    if (!w || !wanted.length) return;
    const minutes = await this.rest.bars(wanted, '1Min', new Date(w.closeMs), { end: new Date(w.endMs), feed: 'sip' });
    for (const symbol of wanted) this.exact.set(symbol, refineWithMinutes(this.rough.get(symbol)!, minutes[symbol] ?? [], w));
  }
}
