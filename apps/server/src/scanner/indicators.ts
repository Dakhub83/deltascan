import type { Bar, Indicators } from '@deltascan/shared';

/** Bars looked back over: plenty for EMA 20 / RSI 14 to settle, cheap to recompute once a minute. */
export const LOOKBACK_BARS = 300;

/** Exponential moving average of `values`, seeded with the simple average of the first `period`. */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** RSI with Wilder's smoothing, as charting platforms draw it. Null until `period + 1` closes. */
export function rsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Indicators from completed 1-minute bars, oldest first. Null with fewer than 20 bars. */
export function computeIndicators(bars: readonly Bar[]): Indicators | null {
  const recent = bars.slice(-LOOKBACK_BARS);
  const closes = recent.map((b) => b.close);
  const fast = emaSeries(closes, 9);
  const slow = emaSeries(closes, 20);
  const ema9 = fast[fast.length - 1];
  const ema20 = slow[slow.length - 1];
  if (ema9 == null || ema20 == null) return null;
  let emaCross: Indicators['emaCross'] = null;
  let side = 0;
  for (let i = 0; i < closes.length; i++) {
    const f = fast[i];
    const s = slow[i];
    if (f == null || s == null || f === s) continue;
    const now = f > s ? 1 : -1;
    if (side !== 0 && now !== side) emaCross = { dir: now > 0 ? 'bull' : 'bear', at: recent[i]!.timestamp };
    side = now;
  }
  return { rsi14: rsi(closes), ema9, ema20, emaCross };
}

/** Recomputes a symbol's indicators only when a new bar has completed. */
export class IndicatorEngine {
  private readonly lastBar = new Map<string, number>();
  private readonly cache = new Map<string, Indicators | null>();

  /** `bars` are the symbol's 1-minute bars, the last one possibly still forming. */
  evaluate(symbol: string, bars: readonly Bar[]): Indicators | null {
    const completed = bars.length - 1;
    const lastTs = completed > 0 ? bars[completed - 1]!.timestamp : -Infinity;
    if (this.lastBar.get(symbol) === lastTs) return this.cache.get(symbol) ?? null;
    const result = completed > 0 ? computeIndicators(bars.slice(Math.max(0, completed - LOOKBACK_BARS), completed)) : null;
    this.lastBar.set(symbol, lastTs);
    this.cache.set(symbol, result);
    return result;
  }
}
