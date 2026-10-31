import type { Bar, ExtendedSessionSeed, ReferenceData, SessionSeed } from '@deltascan/shared';
import { tradeSessionAt } from '../../../market/sessionClock';
import type { AlpacaRawBar, AlpacaRawSnapshot, AlpacaRest } from './AlpacaRest';
import { parseAlpacaTimestamp } from './messages';

/** Minute bars reach back this far: covers the previous trading day across a weekend. */
export const HISTORY_DAYS = 4;
/** Days of daily bars averaged for the RVOL baseline. */
export const AVG_VOLUME_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** "2026-10-30" for the New York calendar day of `ts`. */
export const etDateKey = (ts: number) => etDate.format(ts);

/** Alpaca's movers list returns at most this many gainers per request. */
export const MOVERS_MAX = 50;

/**
 * Common stock, not a derivative. Nasdaq's fifth letter marks warrants (W), rights (R) and units
 * (U), and the gainers list is crowded with them: they don't trade on iex and would use up the
 * plan's symbol limit. Class shares like BRK.B pass.
 */
export function isCommonStock(symbol: string): boolean {
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) return false;
  return !(symbol.length === 5 && /[WRU]$/.test(symbol));
}

export function toBar(symbol: string, raw: AlpacaRawBar): Bar {
  const timestamp = parseAlpacaTimestamp(raw.t);
  return {
    symbol,
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
    vwap: raw.vw,
    tradeCount: raw.n,
    timestamp,
    session: tradeSessionAt(timestamp),
  };
}

/**
 * Yesterday's close. Before today has a daily bar, the latest daily bar *is* yesterday's; once it
 * has one, yesterday's is `prevDailyBar`.
 */
export function prevCloseOf(snap: AlpacaRawSnapshot, now: number): number | null {
  const daily = snap.dailyBar;
  if (!daily) return snap.prevDailyBar?.c ?? null;
  return etDateKey(parseAlpacaTimestamp(daily.t)) === etDateKey(now) ? (snap.prevDailyBar?.c ?? null) : daily.c;
}

function extended(bars: readonly Bar[]): ExtendedSessionSeed | undefined {
  if (!bars.length) return undefined;
  return {
    volume: bars.reduce((sum, b) => sum + b.volume, 0),
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    last: bars[bars.length - 1]!.close,
  };
}

/**
 * Today's session state from today's minute bars, split by session with the same ET clock the
 * store uses, so regular-session open/high/low/VWAP never include pre-market prints.
 */
export function seedFrom(symbol: string, prevClose: number, bars: readonly Bar[], lastTrade: number | null, now: number): SessionSeed {
  const today = etDateKey(now);
  const todays = bars.filter((b) => etDateKey(b.timestamp) === today);
  const regular = todays.filter((b) => b.session === 'regular');
  const pre = todays.filter((b) => b.session === 'pre');
  const post = todays.filter((b) => b.session === 'post');
  const volume = regular.reduce((sum, b) => sum + b.volume, 0);
  const pv = regular.reduce((sum, b) => sum + (b.vwap ?? (b.high + b.low + b.close) / 3) * b.volume, 0);
  const lastBar = todays[todays.length - 1];
  return {
    symbol,
    prevClose,
    open: regular[0]?.open ?? null,
    high: regular.length ? Math.max(...regular.map((b) => b.high)) : null,
    low: regular.length ? Math.min(...regular.map((b) => b.low)) : null,
    last: lastTrade ?? lastBar?.close ?? prevClose,
    volume,
    vwap: volume > 0 ? pv / volume : null,
    tradeCount: regular.reduce((sum, b) => sum + (b.tradeCount ?? 0), 0),
    close: post.length && regular.length ? regular[regular.length - 1]!.close : undefined,
    pre: extended(pre),
    post: extended(post),
  };
}

/** Mean full-day volume over the last `days` sessions before today: the RVOL baseline. */
export function avgDailyVolume(daily: readonly AlpacaRawBar[], now: number, days = AVG_VOLUME_DAYS): number | null {
  const today = etDateKey(now);
  const past = daily.filter((d) => etDateKey(parseAlpacaTimestamp(d.t)) !== today).slice(-days);
  return past.length ? past.reduce((sum, d) => sum + d.v, 0) / past.length : null;
}

export interface BootstrapSink {
  history(symbol: string, bars: Bar[]): void;
  seed(seed: SessionSeed): void;
  reference(ref: ReferenceData): void;
}

/**
 * Seeds the store for `symbols`: recent minute bars (charts + signal replay), today's session
 * state, and the average volume. Symbols Alpaca doesn't know are skipped. Returns what it seeded.
 */
export async function runBootstrap(rest: AlpacaRest, symbols: readonly string[], now: number, sink: BootstrapSink): Promise<string[]> {
  if (!symbols.length) return [];
  const [snaps, minute, daily] = await Promise.all([
    rest.snapshots(symbols),
    rest.bars(symbols, '1Min', new Date(now - HISTORY_DAYS * DAY_MS)),
    rest.bars(symbols, '1Day', new Date(now - (AVG_VOLUME_DAYS * 7) / 5 * DAY_MS - 7 * DAY_MS)),
  ]);
  const seeded: string[] = [];
  for (const symbol of symbols) {
    const bars = (minute[symbol] ?? []).map((b) => toBar(symbol, b));
    if (bars.length) sink.history(symbol, bars);
    const snap = snaps[symbol];
    const prevClose = snap ? prevCloseOf(snap, now) : null;
    if (prevClose !== null) {
      sink.seed(seedFrom(symbol, prevClose, bars, snap?.latestTrade?.p ?? null, now));
      seeded.push(symbol);
    }
    const avgVolume = avgDailyVolume(daily[symbol] ?? [], now);
    if (avgVolume !== null) sink.reference({ symbol, avgVolume });
  }
  return seeded;
}
