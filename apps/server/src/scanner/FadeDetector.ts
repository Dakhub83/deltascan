import type { AlertType, Bar, FadeSignal, FadeStage, FadeState, SymbolSnapshot, TradeSession } from '@deltascan/shared';

export interface FadeOptions {
  /** Up at least this much on prevClose (at the bar's close) to be a spike. */
  spikeMinPct?: number;
  /** In regular hours, an extension must close at least this far above VWAP. */
  extensionVwapPct?: number;
  /** A rejection candle's upper wick is at least this fraction of its range. */
  rejectionWick?: number;
  /**
   * A reversal candle: red, at the high, closing in this bottom fraction of its range…
   * (opens near the high and sells straight down, so it has little upper wick)
   */
  reversalClosePos?: number;
  /** …with a range of at least this percent of the price. */
  reversalMinRangePct?: number;
  /** A rejection candle's high is within this fraction of the session high. */
  nearHigh?: number;
  /** Bars without a new high before a red bar breaking the prior low also counts as a rejection. */
  stallBars?: number;
  /** A stall only counts while the previous bar is within this fraction of the high. */
  stallNearHigh?: number;
  /**
   * Past this far off the high, a topping candle or a confirmation is the back side of the move: the setup goes
   * straight to fade with no alert, so the alert never invites a late entry.
   */
  maxConfirmOffHighPct?: number;
  /** Confirmed setups become a fade this far off the high (or on losing VWAP). */
  fadeOffHighPct?: number;
  /** A backside bounce reaches within this fraction of VWAP from below. */
  vwapTouch?: number;
  /** A backside bounce must retrace at least this fraction of the drop from the risk level to the low… */
  bounceRetrace?: number;
  /** …and at least this percent off the low, so a one-tick wiggle isn't a bounce. */
  bounceMinPct?: number;
  /** A failed bounce must roll over within this many bars of its high. */
  bounceRollBars?: number;
  /** Past this far off the high, a failed bounce is chasing the back side and doesn't alert. */
  maxBounceOffHighPct?: number;
  /**
   * Only names at or above this price are tracked, so alerts match what the Fade Setups scanner
   * shows (keep in sync with FADE in apps/web/src/scanners/fade.ts). Float isn't a filter.
   */
  minPrice?: number;
  /** Bars older than this are replayed silently (startup backfill), without alerts. */
  alertMaxAgeMs?: number;
  /** Signals kept per symbol for the chart, replayed ones included. */
  maxSignals?: number;
}

export type FadeAlert = (type: AlertType, symbol: string, price: number, detail: string) => void;

interface SymbolState {
  session: TradeSession | null;
  lastTs: number;
  stage: FadeStage | null;
  since: number;
  high: number;
  highAt: number;
  barsSinceHigh: number;
  /** The session's first bar open: a gapper that closes back under it is failing. */
  sessionOpen: number | null;
  rejection: { high: number; low: number } | null;
  confirmLevel: number | null;
  /** Backside tracking: the low of the current leg down, and the high of the bounce off it. */
  swingLow: number | null;
  /** Closed under VWAP since the stock topped; cleared by a new extension or a reclaim. */
  vwapBroken: boolean;
  bounce: { high: number; bars: number } | null;
  lowerHigh: number | null;
  prev: Bar | null;
}

const fresh = (): SymbolState => ({
  session: null,
  lastTs: -Infinity,
  stage: null,
  since: 0,
  high: -Infinity,
  highAt: 0,
  barsSinceHigh: 0,
  sessionOpen: null,
  rejection: null,
  confirmLevel: null,
  swingLow: null,
  vwapBroken: false,
  bounce: null,
  lowerHigh: null,
  prev: null,
});

/** A gap this long between bars is the overnight break. */
const OVERNIGHT_GAP_MS = 4 * 60 * 60_000;

const fmt = (n: number) => n.toFixed(n < 1 ? 4 : 2);

/**
 * Tracks each runner through Spike → Extension → Rejection → Confirmation → Fade on completed
 * 1-minute bars (the bar in progress is ignored, so nothing confirms intrabar). Fires `topping`
 * (the starter), `rejection_confirmed`, `vwap_break` (the first close under VWAP after the top: the
 * main add), `failed_bounce` (a lower high rolling over) and `vwap_bounce` alerts. VWAP is the
 * snapshot's current session VWAP.
 */
export class FadeDetector {
  private readonly o: Required<Omit<FadeOptions, 'alertMaxAgeMs'>> & { alertMaxAgeMs: number };
  private readonly states = new Map<string, SymbolState>();
  /** Outlives SymbolState, which resets each session. */
  private readonly history = new Map<string, FadeSignal[]>();

  constructor(
    private readonly onAlert: FadeAlert,
    opts: FadeOptions = {},
  ) {
    this.o = {
      spikeMinPct: 15,
      extensionVwapPct: 5,
      rejectionWick: 0.4,
      reversalClosePos: 0.3,
      reversalMinRangePct: 3,
      nearHigh: 0.01,
      stallBars: 3,
      stallNearHigh: 0.03,
      maxConfirmOffHighPct: 15,
      fadeOffHighPct: 8,
      vwapTouch: 0.015,
      bounceRetrace: 0.25,
      bounceMinPct: 2,
      bounceRollBars: 3,
      maxBounceOffHighPct: 35,
      minPrice: 1,
      alertMaxAgeMs: 3 * 60_000,
      maxSignals: 100,
      ...opts,
    };
  }

  /** Every signal found for the symbol, oldest first, including ones replayed without alerting. */
  signals(symbol: string): FadeSignal[] {
    return this.history.get(symbol) ?? [];
  }

  /** Processes any newly completed bars; returns the symbol's current state. */
  evaluate(snap: Readonly<SymbolSnapshot>, bars: readonly Bar[], now = Date.now()): FadeState | null {
    if (!this.eligible(snap)) {
      this.states.delete(snap.symbol);
      return null;
    }
    let st = this.states.get(snap.symbol);
    if (!st) this.states.set(snap.symbol, (st = fresh()));
    // The last bar is still forming. Bars before the overnight gap are a previous day: measured
    // against today's prevClose they'd make up spikes and gaps, so they're skipped.
    const last = bars.length - 1;
    let start = 0;
    if (last > 0 && bars[last - 1]!.timestamp > st.lastTs) {
      for (let i = last - 1; i > 0; i--) {
        if (bars[i]!.timestamp - bars[i - 1]!.timestamp >= OVERNIGHT_GAP_MS) {
          start = i;
          break;
        }
      }
    }
    for (let i = start; i < last; i++) {
      const b = bars[i]!;
      if (b.timestamp <= st.lastTs) continue;
      st = this.step(st, b, snap, now - b.timestamp <= this.o.alertMaxAgeMs);
      st.lastTs = b.timestamp;
      st.prev = b;
      this.states.set(snap.symbol, st);
    }
    return st.stage
      ? {
          stage: st.stage,
          since: st.since,
          high: st.high,
          highAt: st.highAt,
          rejectionHigh: st.rejection?.high ?? null,
          rejectionLow: st.rejection?.low ?? null,
          confirmLevel: st.confirmLevel,
          lowerHigh: st.lowerHigh,
          vwapBroken: st.vwapBroken,
        }
      : null;
  }

  private eligible(s: Readonly<SymbolSnapshot>): boolean {
    if (s.last !== null && s.last < this.o.minPrice) return false;
    return true;
  }

  /**
   * Topping patterns, from Spike or Extension: a topping tail, a reversal candle, a stall under the
   * high, or (regular hours) a gap of spikeMinPct+ closing back under its opening price.
   */
  private checkTop(
    st: SymbolState,
    b: Bar,
    snap: Readonly<SymbolSnapshot>,
    session: TradeSession,
    newHigh: boolean,
    offHigh: number,
    enter: (stage: FadeStage) => void,
    alert: (type: AlertType, detail: string) => void,
  ) {
    const o = this.o;
    const range = b.high - b.low;
    const wick = b.high - Math.max(b.open, b.close);
    const red = b.close < b.open;
    const atHigh = range > 0 && red && b.high >= st.high * (1 - o.nearHigh);
    const toppingTail = atHigh && wick / range >= o.rejectionWick;
    const reversal = atHigh && (b.close - b.low) / range <= o.reversalClosePos && (range / b.high) * 100 >= o.reversalMinRangePct;
    const stalled =
      st.barsSinceHigh >= o.stallBars && red && st.prev !== null && st.prev.high >= st.high * (1 - o.stallNearHigh) && b.close < st.prev.low;
    const gapPct = snap.prevClose && st.sessionOpen !== null ? (st.sessionOpen / snap.prevClose - 1) * 100 : 0;
    const gapFail =
      session === 'regular' &&
      gapPct >= o.spikeMinPct &&
      red &&
      !newHigh &&
      st.prev !== null &&
      b.close < st.sessionOpen! &&
      b.close < st.prev.low;

    // A top called this far off the high would be a late starter: the else branch fades it silently.
    if ((toppingTail || reversal || stalled || gapFail) && offHigh < o.maxConfirmOffHighPct) {
      st.rejection = toppingTail || reversal ? { high: b.high, low: b.low } : { high: st.high, low: b.low };
      enter('rejection');
      const r = st.rejection;
      const why = toppingTail
        ? `Topping tail at ${fmt(r.high)} (${Math.round((wick / range) * 100)}% wick)`
        : reversal
          ? `Reversal candle off ${fmt(r.high)}: ${((range / b.high) * 100).toFixed(1)}% range, closed ${fmt(b.close)} near the low`
          : gapFail
            ? `Gap failing: gapped +${gapPct.toFixed(0)}% to ${fmt(st.sessionOpen!)}, red bar closed ${fmt(b.close)} under the open`
            : `Failed at ${fmt(r.high)} for ${st.barsSinceHigh}m, red bar broke ${fmt(st.prev!.low)}`;
      alert('topping', `${why} · starter: risk over ${fmt(r.high)}, confirms under ${fmt(r.low)}`);
    } else if (offHigh >= o.maxConfirmOffHighPct) {
      enter('fade'); // topped without a clean rejection; too late to call one now
    }
  }

  /** A bounce off the backside low that makes a lower high, then a red bar breaking the prior low. */
  private trackBounce(st: SymbolState, b: Bar, offHigh: number, alert: (type: AlertType, detail: string) => void) {
    const o = this.o;
    const ceiling = st.rejection?.high ?? st.high;
    if (st.swingLow === null || b.low < st.swingLow) {
      st.swingLow = b.low;
      st.bounce = null;
      return;
    }
    if (b.high >= ceiling) return; // not a lower high; the stage logic handles the reclaim
    if (!st.bounce || b.high > st.bounce.high) st.bounce = { high: b.high, bars: 0 };
    else st.bounce.bars++;

    const { high } = st.bounce;
    const low = st.swingLow;
    const big = high - low >= o.bounceRetrace * (ceiling - low) && (high / low - 1) * 100 >= o.bounceMinPct;
    const rolled = st.bounce.bars <= o.bounceRollBars && b.close < b.open && st.prev !== null && b.close < st.prev.low;
    if (!big || !rolled) return;
    st.lowerHigh = high;
    st.swingLow = b.low;
    st.bounce = null;
    if (offHigh <= o.maxBounceOffHighPct) {
      alert('failed_bounce', `Lower high ${fmt(high)} under ${fmt(ceiling)}, bounce off ${fmt(low)} failed · add: risk over ${fmt(high)}`);
    }
  }

  private step(st: SymbolState, b: Bar, snap: Readonly<SymbolSnapshot>, live: boolean): SymbolState {
    const o = this.o;
    const session = b.session ?? 'regular';
    if (st.session !== session) st = { ...fresh(), session, lastTs: st.lastTs };
    st.sessionOpen ??= b.open;

    const newHigh = b.high > st.high;
    if (newHigh) {
      st.high = b.high;
      st.highAt = b.timestamp;
      st.barsSinceHigh = 0;
    } else {
      st.barsSinceHigh++;
    }

    const vwap = session === 'regular' ? snap.vwap : null;
    const chg = snap.prevClose ? (b.close / snap.prevClose - 1) * 100 : 0;
    const offHigh = (1 - b.close / st.high) * 100;
    const enter = (stage: FadeStage) => {
      st.stage = stage;
      st.since = b.timestamp + 60_000;
      if (stage === 'spike' || stage === 'extension') {
        st.swingLow = null;
        st.bounce = null;
        st.lowerHigh = null;
        st.vwapBroken = false;
      }
    };
    const alert = (type: AlertType, detail: string) => {
      let list = this.history.get(snap.symbol);
      if (!list) this.history.set(snap.symbol, (list = []));
      list.push({ type, barTime: b.timestamp, price: b.close, detail });
      if (list.length > o.maxSignals) list.shift();
      if (live) this.onAlert(type, snap.symbol, b.close, detail);
    };

    if (st.stage === 'confirmation' || st.stage === 'fade' || st.stage === 'vwap-bounce') this.trackBounce(st, b, offHigh, alert);

    // Measured at the bar's high, so a gap that fails inside its first minute still counts as a spike.
    const highChg = snap.prevClose ? (b.high / snap.prevClose - 1) * 100 : 0;
    if (st.stage === null && Math.max(chg, highChg) >= o.spikeMinPct) enter('spike');

    switch (st.stage) {
      case null:
        break;

      case 'spike':
        if (newHigh && (vwap === null || b.close >= vwap * (1 + o.extensionVwapPct / 100))) enter('extension');
        // A gap-and-fail never extends: it can top straight from the spike.
        else this.checkTop(st, b, snap, session, newHigh, offHigh, enter, alert);
        break;

      case 'extension':
        this.checkTop(st, b, snap, session, newHigh, offHigh, enter, alert);
        break;

      case 'rejection':
        if (b.high > st.rejection!.high) {
          st.rejection = null;
          enter('extension');
          this.checkTop(st, b, snap, session, newHigh, offHigh, enter, alert); // the new high itself may reverse
        } else if (b.close < st.rejection!.low) {
          st.confirmLevel = st.rejection!.low;
          if (offHigh >= o.maxConfirmOffHighPct) {
            enter('fade');
          } else {
            enter('confirmation');
            alert('rejection_confirmed', `Rejected ${fmt(st.rejection!.high)}, closed below ${fmt(st.rejection!.low)} · ${offHigh.toFixed(1)}% off high`);
          }
        }
        break;

      case 'confirmation':
        if (b.high > st.rejection!.high) {
          st.rejection = null;
          st.confirmLevel = null;
          enter('extension');
          this.checkTop(st, b, snap, session, newHigh, offHigh, enter, alert); // the new high itself may reverse
        } else if (offHigh >= o.fadeOffHighPct || (vwap !== null && b.close < vwap)) {
          enter('fade');
        }
        break;

      case 'fade':
        if (newHigh) {
          st.rejection = null;
          st.confirmLevel = null;
          enter('extension');
          this.checkTop(st, b, snap, session, newHigh, offHigh, enter, alert); // the new high itself may reverse
        } else if (st.vwapBroken && vwap !== null && b.close < vwap && b.high >= vwap * (1 - o.vwapTouch)) {
          // Already under VWAP before this bar: a candle that opens over it and closes under is the break, not a bounce.
          enter('vwap-bounce');
          alert('vwap_bounce', `Bounced into VWAP ${fmt(vwap)} from below · ${offHigh.toFixed(1)}% off high`);
        }
        break;

      case 'vwap-bounce':
        if (vwap !== null && b.close > vwap * (1 + o.vwapTouch)) {
          // Reclaimed VWAP: the backside short is off until it extends and rejects again.
          st.rejection = null;
          st.confirmLevel = null;
          enter('spike');
        } else if (vwap !== null && b.close < vwap * (1 - 3 * o.vwapTouch)) {
          enter('fade');
        }
        break;
    }

    const topped = st.stage !== null && st.stage !== 'spike' && st.stage !== 'extension';
    if (st.vwapBroken && vwap !== null && b.close > vwap * (1 + o.vwapTouch)) {
      // Squeezed back over VWAP: the add is off until it breaks again.
      st.vwapBroken = false;
    } else if (topped && !st.vwapBroken && vwap !== null && b.close < vwap) {
      st.vwapBroken = true;
      alert(
        'vwap_break',
        `Closed ${fmt(b.close)} under VWAP ${fmt(vwap)}, ${offHigh.toFixed(1)}% off high · add the rest; off on a close over ${fmt(vwap * (1 + o.vwapTouch))}`,
      );
    }
    return st;
  }
}
