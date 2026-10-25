import type { MarketSession, TradeSession } from '@deltascan/shared';

const PRE_OPEN_MIN = 4 * 60; // 04:00 ET
const REGULAR_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const REGULAR_CLOSE_MIN = 16 * 60; // 16:00 ET
const POST_CLOSE_MIN = 20 * 60; // 20:00 ET
const REGULAR_SESSION_MIN = REGULAR_CLOSE_MIN - REGULAR_OPEN_MIN;

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
  hourCycle: 'h23',
});

/** Minutes since midnight in New York for the given instant. */
export function etMinutesOfDay(now: number): number {
  let hour = 0;
  let minute = 0;
  for (const part of etFormatter.formatToParts(now)) {
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/** Which session a trade at `ts` belongs to. Exchange holidays are not modelled yet. */
export function tradeSessionAt(ts: number): TradeSession {
  const mins = etMinutesOfDay(ts);
  if (mins < REGULAR_OPEN_MIN) return 'pre';
  if (mins < REGULAR_CLOSE_MIN) return 'regular';
  return 'post';
}

/** The session running at `now`, for display ("Pre-market", "After hours", …). */
export function marketSessionAt(now: number): MarketSession {
  const weekday = etFormatter.formatToParts(now).find((p) => p.type === 'weekday')?.value;
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  const mins = etMinutesOfDay(now);
  if (mins < PRE_OPEN_MIN || mins >= POST_CLOSE_MIN) return 'closed';
  return tradeSessionAt(now);
}

/**
 * Fraction of the regular session (09:30–16:00 ET) elapsed, clamped to [0, 1].
 * Linear for now; a U-shaped intraday volume curve is a later refinement.
 */
export function regularSessionFraction(now: number): number {
  const elapsed = etMinutesOfDay(now) - REGULAR_OPEN_MIN;
  return Math.min(1, Math.max(0, elapsed / REGULAR_SESSION_MIN));
}

/** Simulated clock for the mock feed: starts mid-session and advances in real time. */
export function mockSessionFraction(startFraction: number, startedAt = Date.now()) {
  const sessionMs = REGULAR_SESSION_MIN * 60_000;
  return (now: number) => Math.min(1, startFraction + (now - startedAt) / sessionMs);
}
