import type { Bar, SymbolSnapshot } from '@deltascan/shared';

const MINUTE_MS = 60_000;
const TREND_MINUTES = 60;
const VOLUME_BUCKETS = 6;
/** Minutes of bars weighed for buyers vs sellers. */
const CONTROL_BARS = 15;
const REGULAR_SESSION_MINUTES = 390;

export type Side = 'buyers' | 'sellers' | 'balanced';

export interface TapeRead {
  /** Closes over the last hour, oldest first, and volume in ten-minute buckets. */
  trend: { closes: number[]; volumes: { value: number; up: boolean }[]; changePct: number | null };
  /** 0–100: volume-weighted position of each close within its bar's range. */
  control: { score: number; side: Side } | null;
  volume: 'expanding' | 'contracting' | 'steady' | null;
  momentum: 'up' | 'down' | 'flat' | null;
  /** Latest minute's volume vs. the stock's normal per-minute volume. */
  volMultiple: number | null;
  status: { tone: 'up' | 'down' | 'neutral'; text: string } | null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const price = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
export const fmtMultiple = (m: number) => (m >= 50 ? '50×+' : `${m >= 10 ? Math.round(m) : m.toFixed(1)}×`);

/**
 * A quick read of who is in control, from 1-minute bars and the live snapshot. Includes the bar
 * still forming, so it reacts within the minute.
 */
export function readTape(bars: readonly Bar[], snap: SymbolSnapshot, now = Date.now()): TapeRead {
  const hour = bars.filter((b) => b.timestamp >= now - TREND_MINUTES * MINUTE_MS);
  const closes = hour.map((b) => b.close);
  const bucketMs = (TREND_MINUTES / VOLUME_BUCKETS) * MINUTE_MS;
  const start = now - TREND_MINUTES * MINUTE_MS;
  const volumes = Array.from({ length: VOLUME_BUCKETS }, (_, i) => {
    const inBucket = hour.filter((b) => b.timestamp >= start + i * bucketMs && b.timestamp < start + (i + 1) * bucketMs);
    return {
      value: inBucket.reduce((s, b) => s + b.volume, 0),
      up: inBucket.length > 0 && inBucket.at(-1)!.close >= inBucket[0]!.open,
    };
  });
  const changePct = hour.length ? (hour.at(-1)!.close / hour[0]!.open - 1) * 100 : null;

  const recent = bars.slice(-CONTROL_BARS);
  const totalVolume = recent.reduce((s, b) => s + b.volume, 0);
  let control: TapeRead['control'] = null;
  if (recent.length >= 3 && totalVolume > 0) {
    const pressure = recent.reduce((s, b) => s + b.volume * (b.high > b.low ? (b.close - b.low) / (b.high - b.low) : 0.5), 0);
    const score = Math.round((pressure / totalVolume) * 100);
    control = { score, side: score >= 60 ? 'buyers' : score <= 40 ? 'sellers' : 'balanced' };
  }

  const last5 = avg(bars.slice(-5).map((b) => b.volume));
  const prior15 = avg(bars.slice(-20, -5).map((b) => b.volume));
  const volume = bars.length >= 10 && prior15 > 0 ? (last5 > prior15 * 1.3 ? 'expanding' : last5 < prior15 * 0.7 ? 'contracting' : 'steady') : null;

  const move = snap.chg5mPct;
  const momentum = move == null ? null : move > 0.5 ? 'up' : move < -0.5 ? 'down' : 'flat';

  // The forming bar is partial, so judge volume on the last completed minute.
  const lastFull = bars.length >= 2 ? bars.at(-2)! : bars.at(-1);
  const normalPerMinute = snap.avgVolume ? snap.avgVolume / REGULAR_SESSION_MINUTES : avg(bars.slice(-21, -1).map((b) => b.volume));
  const volMultiple = lastFull && normalPerMinute > 0 ? lastFull.volume / normalPerMinute : null;

  return { trend: { closes, volumes, changePct }, control, volume, momentum, volMultiple, status: statusLine(snap, momentum, volMultiple) };
}

function statusLine(s: SymbolSnapshot, momentum: TapeRead['momentum'], mult: number | null): TapeRead['status'] {
  if (s.last == null) return null;
  if (s.halted) return { tone: 'neutral', text: 'HALTED' };
  const vol = mult !== null && mult >= 2 ? ` · ${fmtMultiple(mult)} vol` : '';
  if (s.high != null && s.last >= s.high * 0.995 && momentum === 'up') return { tone: 'up', text: `▲ RUNNING through ${price(s.last)}${vol}` };
  if (s.fade?.stage === 'confirmation' && s.fade.rejectionHigh != null) return { tone: 'down', text: `▼ REJECTED at ${price(s.fade.rejectionHigh)}` };
  if (s.fade && (s.fade.stage === 'fade' || s.fade.stage === 'vwap-bounce')) {
    return { tone: 'down', text: `▼ FADING ${((1 - s.last / s.fade.high) * 100).toFixed(1)}% off high${vol}` };
  }
  if (s.vwap != null) {
    return s.last >= s.vwap
      ? { tone: 'up', text: `Holding above VWAP ${price(s.vwap)}` }
      : { tone: 'down', text: `Below VWAP ${price(s.vwap)}` };
  }
  return null;
}
