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
   * The backside needs a real move off the high: in the first minutes VWAP sits on the price, so
   * a 0.5% wiggle would otherwise meet every other condition.
   */
  backsideMinOffHighPct?: number;
  /** Fading into VWAP: a close at most this far above it… */
  vwapApproachPct?: number;
  /** …armed again only once price pulls back more than this far above VWAP. */
  vwapRearmPct?: number;
  /** Bars older than this are replayed silently (startup backfill), without alerts. */
  alertMaxAgeMs?: number;
  /** Signals kept per symbol for the chart, replayed ones included. */
  maxSignals?: number;
}

export type FadeAlert = (type: AlertType, symbol: string, price: number, detail: string) => void;

interface SymbolState {
  session: TradeSession | null;
  lastTs: number;
  /** The oldest bar seen in the store, to notice history arriving after live bars. */
  firstSeen: number | null;
  stage: FadeStage | null;
  since: number;
  high: number;
  highAt: number;
  barsSinceHigh: number;
  /** The session's first bar open: a gapper that closes back under it is failing. */
  sessionOpen: number | null;
  /** Regular-session VWAP built from the bars, as the chart draws it, for replayed bars. */
  pv: number;
  vol: number;
  rejection: { high: number; low: number } | null;
  confirmLevel: number | null;
  /** Backside tracking: the low of the current leg down, and the high of the bounce off it. */
  swingLow: number | null;
  /** Closed under VWAP since the stock topped; cleared by a new extension or a reclaim. */
  vwapBroken: boolean;
  bounce: { high: number; bars: number } | null;
  lowerHigh: number | null;
  backsideStop: number | null;
  vwapTest: boolean;
  prev: Bar | null;
}

const fresh = (): SymbolState => ({
  session: null,
  lastTs: -Infinity,
  firstSeen: null,
  stage: null,
  since: 0,
  high: -Infinity,
  highAt: 0,
  barsSinceHigh: 0,
  sessionOpen: null,
  pv: 0,
  vol: 0,
  rejection: null,
  confirmLevel: null,
  swingLow: null,
  vwapBroken: false,
  bounce: null,
  lowerHigh: null,
  backsideStop: null,
  vwapTest: false,
  prev: null,
});

/** A gap this long between bars is the overnight break. */
const OVERNIGHT_GAP_MS = 4 * 60 * 60_000;

const fmt = (n: number) => n.toFixed(n < 1 ? 4 : 2);

/**
 * Tracks each runner through Spike → Extension → Rejection → Confirmation → Fade on completed
 * 1-minute bars (the bar in progress is ignored, so nothing confirms intrabar). Fires `topping`
 * (the starter), `rejection_confirmed`, `vwap_break` (the first close under VWAP after the top: the
 * main add) and `vwap_test` before it (fading into VWAP), `failed_bounce` (a lower high rolling over),
 * `vwap_bounce` and `backside` alerts. VWAP is the
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
      backsideMinOffHighPct: 3,
      vwapApproachPct: 2,
      vwapRearmPct: 4,
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
    // Every stock is tracked, whatever its price or float: the trader filters in the scanner.
    let st = this.states.get(snap.symbol);
    if (!st) this.states.set(snap.symbol, (st = fresh()));
    // A symbol added mid-day gets its history after its first live bars: older bars now sit in
    // front of what was processed, so start over and replay the morning (high, top, setup).
    const first = bars[0]?.timestamp;
    if (first !== undefined && st.firstSeen !== null && first < st.firstSeen) {
      this.states.set(snap.symbol, (st = fresh()));
      this.history.delete(snap.symbol);
    }
    if (first !== undefined) st.firstSeen = first;
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
          backsideStop: st.backsideStop,
          vwapTest: st.vwapTest,
        }
      : null;
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
    // The snapshot has the real open; the first bar seen is only a fallback (a server started at
    // 11:00 would otherwise treat 11:00 as the open).
    const open = snap.open ?? st.sessionOpen;
    const gapPct = snap.prevClose && open !== null ? (open / snap.prevClose - 1) * 100 : 0;
    const gapFail =
      session === 'regular' && open !== null && gapPct >= o.spikeMinPct && red && !newHigh && st.prev !== null && b.close < open && b.close < st.prev.low;

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
            ? `Gap failing: gapped +${gapPct.toFixed(0)}% to ${fmt(open!)}, red bar closed ${fmt(b.close)} under the open`
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
    if (st.session !== session) st = { ...fresh(), session, lastTs: st.lastTs, firstSeen: st.firstSeen };
    st.sessionOpen ??= b.open;

    const newHigh = b.high > st.high;
    if (newHigh) {
      st.high = b.high;
      st.highAt = b.timestamp;
      st.barsSinceHigh = 0;
    } else {
      st.barsSinceHigh++;
    }

    if (session === 'regular') {
      st.pv += ((b.high + b.low + b.close) / 3) * b.volume;
      st.vol += b.volume;
    }
    // The snapshot's VWAP is today's latest: right for a bar that just closed, wrong for a replayed
    // 9:35 bar, which is judged against VWAP as of that bar instead.
    const vwap = session !== 'regular' ? null : live || st.vol === 0 ? snap.vwap : st.pv / st.vol;
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
        st.backsideStop = null;
        st.vwapTest = false;
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
    const stop = st.lowerHigh ?? st.rejection?.high ?? st.high;

    // Anticipating the break: topped, still over VWAP but within reach, and weakening.
    if (st.vwapTest && vwap !== null && b.close > vwap * (1 + o.vwapRearmPct / 100)) {
      st.vwapTest = false; // pulled away: the next approach is a new one
    } else if (
      topped &&
      !st.vwapTest &&
      !st.vwapBroken &&
      vwap !== null &&
      b.close >= vwap &&
      b.close <= vwap * (1 + o.vwapApproachPct / 100) &&
      offHigh >= o.backsideMinOffHighPct &&
      b.close < b.open &&
      ((st.prev !== null && b.close < st.prev.low) || st.lowerHigh !== null)
    ) {
      st.vwapTest = true;
      alert(
        'vwap_test',
        `Fading into VWAP: closed ${fmt(b.close)}, ${((b.close / vwap - 1) * 100).toFixed(1)}% over VWAP ${fmt(vwap)}, ${offHigh.toFixed(1)}% off the ${fmt(st.high)} high · anticipate the break: risk over ${fmt(stop)}`,
      );
    }

    if (st.vwapBroken && vwap !== null && b.close > vwap * (1 + o.vwapTouch)) {
      // Squeezed back over VWAP: the add is off until it breaks again.
      st.vwapBroken = false;
    } else if (topped && !st.vwapBroken && vwap !== null && b.close < vwap) {
      st.vwapBroken = true;
      st.vwapTest = false; // the anticipated break happened; after a reclaim the next approach warns again
      alert(
        'vwap_break',
        `Closed ${fmt(b.close)} under VWAP ${fmt(vwap)}, ${offHigh.toFixed(1)}% off high · add the rest; off on a close over ${fmt(vwap * (1 + o.vwapTouch))}`,
      );
    }

    // The one "start shorting" signal: topped, the failure proven (a confirmed top or a lower high),
    // and a red bar closing under VWAP. Once per setup; a new high starts a new one.
    const failed = st.confirmLevel !== null || st.lowerHigh !== null;
    if (
      topped &&
      failed &&
      st.backsideStop === null &&
      vwap !== null &&
      b.close < vwap &&
      b.close < b.open &&
      offHigh >= o.backsideMinOffHighPct &&
      offHigh <= o.maxBounceOffHighPct
    ) {
      st.backsideStop = stop;
      const proof = st.lowerHigh !== null ? `lower high ${fmt(st.lowerHigh)}` : `top confirmed under ${fmt(st.confirmLevel!)}`;
      alert(
        'backside',
        `Backside: topped at ${fmt(st.high)}, ${proof}, closed ${fmt(b.close)} under VWAP ${fmt(vwap)} · short: risk over ${fmt(stop)}`,
      );
    }
    return st;
  }
}
