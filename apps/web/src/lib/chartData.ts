import type { Bar } from '@deltascan/shared';

const MINUTE_MS = 60_000;

export const TIMEFRAMES = [1, 5, 15, 60] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const timeframeLabel = (tf: Timeframe) => (tf === 60 ? '1h' : `${tf}m`);

/** Inserts a live bar into 1-minute history, replacing the bar for the same minute. */
export function upsertBar(bars: Bar[], bar: Bar): void {
  const last = bars[bars.length - 1];
  if (last && last.timestamp === bar.timestamp) bars[bars.length - 1] = bar;
  else if (!last || bar.timestamp > last.timestamp) bars.push(bar);
}

/** Rolls 1-minute bars up into `tf`-minute bars. A bar takes the session of its first minute. */
export function aggregate(bars: readonly Bar[], tf: Timeframe, includeExtended: boolean): Bar[] {
  const size = tf * MINUTE_MS;
  const out: Bar[] = [];
  for (const b of bars) {
    if (!includeExtended && b.session && b.session !== 'regular') continue;
    const start = Math.floor(b.timestamp / size) * size;
    const cur = out[out.length - 1];
    if (cur && cur.timestamp === start) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    } else {
      out.push({ ...b, timestamp: start });
    }
  }
  return out;
}

/** Exponential moving average of closes; null until `period` bars are available. */
export function ema(bars: readonly Bar[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  let value: number | null = null;
  let seedSum = 0;
  return bars.map((b, i) => {
    if (i < period - 1) {
      seedSum += b.close;
      return null;
    }
    if (value === null) value = (seedSum + b.close) / period;
    else value = b.close * k + value * (1 - k);
    return value;
  });
}

/**
 * Session VWAP over regular-hours bars, restarting at each day's open. Extended-hours bars
 * get null, and `starts[i]` marks the first bar of each day, so the line can break there.
 */
export function sessionVwap(bars: readonly Bar[]): { values: (number | null)[]; starts: boolean[] } {
  let pv = 0;
  let vol = 0;
  let prevRegular: Bar | null = null;
  const starts: boolean[] = [];
  const values = bars.map((b) => {
    starts.push(false);
    if (b.session && b.session !== 'regular') return null;
    // A gap of more than an hour between regular bars means a new trading day.
    if (!prevRegular || b.timestamp - prevRegular.timestamp > 60 * MINUTE_MS) {
      pv = 0;
      vol = 0;
      starts[starts.length - 1] = true;
    }
    prevRegular = b;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    return vol > 0 ? pv / vol : null;
  });
  return { values, starts };
}
