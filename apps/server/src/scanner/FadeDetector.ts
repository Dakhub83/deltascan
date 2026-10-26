import type { AlertType, Bar, FadeStage, FadeState, SymbolSnapshot, TradeSession } from '@deltascan/shared';

export interface FadeOptions {
  /** Up at least this much on prevClose (at the bar's close) to be a spike. */
  spikeMinPct?: number;
  /** In regular hours, an extension must close at least this far above VWAP. */
  extensionVwapPct?: number;
  /** A rejection candle's upper wick is at least this fraction of its range. */
  rejectionWick?: number;
  /** A rejection candle's high is within this fraction of the session high. */
  nearHigh?: number;
  /** Bars without a new high before a red bar breaking the prior low also counts as a rejection. */
  stallBars?: number;
  /** A stall only counts while the previous bar is within this fraction of the high. */
  stallNearHigh?: number;
  /**
   * Past this far off the high, a confirmation is the back side of the move: the setup goes
   * straight to fade with no alert, so the alert never invites a late entry.
   */
  maxConfirmOffHighPct?: number;
  /** Confirmed setups become a fade this far off the high (or on losing VWAP). */
  fadeOffHighPct?: number;
  /** A backside bounce reaches within this fraction of VWAP from below. */
  vwapTouch?: number;
  /**
   * Only names inside these floors are tracked, so alerts match what the Fade Setups scanner
   * shows (keep in sync with FADE in apps/web/src/scanners/fade.ts). Unknown float passes.
   */
  minPrice?: number;
  minFloat?: number;
  maxFloat?: number;
  /** Bars older than this are replayed silently (startup backfill), without alerts. */
  alertMaxAgeMs?: number;
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
  rejection: { high: number; low: number } | null;
  confirmLevel: number | null;
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
  rejection: null,
  confirmLevel: null,
  prev: null,
});

const fmt = (n: number) => n.toFixed(n < 1 ? 4 : 2);

/**
 * Tracks each runner through Spike → Extension → Rejection → Confirmation → Fade on completed
 * 1-minute bars (the bar in progress is ignored, so nothing confirms intrabar). Fires
 * `rejection_confirmed` and `vwap_bounce` alerts. VWAP is the snapshot's current session VWAP.
 */
export class FadeDetector {
  private readonly o: Required<Omit<FadeOptions, 'alertMaxAgeMs'>> & { alertMaxAgeMs: number };
  private readonly states = new Map<string, SymbolState>();

  constructor(
    private readonly onAlert: FadeAlert,
    opts: FadeOptions = {},
  ) {
    this.o = {
      spikeMinPct: 15,
      extensionVwapPct: 5,
      rejectionWick: 0.4,
      nearHigh: 0.01,
      stallBars: 3,
      stallNearHigh: 0.03,
      maxConfirmOffHighPct: 15,
      fadeOffHighPct: 8,
      vwapTouch: 0.015,
      minPrice: 1,
      minFloat: 2e6,
      maxFloat: 30e6,
      alertMaxAgeMs: 3 * 60_000,
      ...opts,
    };
  }

  /** Processes any newly completed bars; returns the symbol's current state. */
  evaluate(snap: Readonly<SymbolSnapshot>, bars: readonly Bar[], now = Date.now()): FadeState | null {
    if (!this.eligible(snap)) {
      this.states.delete(snap.symbol);
      return null;
    }
    let st = this.states.get(snap.symbol);
    if (!st) this.states.set(snap.symbol, (st = fresh()));
    // The last bar is still forming.
    for (let i = 0; i < bars.length - 1; i++) {
      const b = bars[i]!;
      if (b.timestamp <= st.lastTs) continue;
      st = this.step(st, b, snap, now - b.timestamp <= this.o.alertMaxAgeMs);
      st.lastTs = b.timestamp;
      st.prev = b;
      this.states.set(snap.symbol, st);
    }
    return st.stage
      ? { stage: st.stage, since: st.since, high: st.high, highAt: st.highAt, rejectionHigh: st.rejection?.high ?? null, confirmLevel: st.confirmLevel }
      : null;
  }

  private eligible(s: Readonly<SymbolSnapshot>): boolean {
    if (s.last !== null && s.last < this.o.minPrice) return false;
    if (s.floatShares !== null && (s.floatShares < this.o.minFloat || s.floatShares > this.o.maxFloat)) return false;
    return true;
  }

  private step(st: SymbolState, b: Bar, snap: Readonly<SymbolSnapshot>, live: boolean): SymbolState {
    const o = this.o;
    const session = b.session ?? 'regular';
    if (st.session !== session) st = { ...fresh(), session, lastTs: st.lastTs };

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
    };
    const alert = (type: AlertType, detail: string) => live && this.onAlert(type, snap.symbol, b.close, detail);

    switch (st.stage) {
      case null:
        if (chg >= o.spikeMinPct) enter('spike');
        break;

      case 'spike':
        if (newHigh && (vwap === null || b.close >= vwap * (1 + o.extensionVwapPct / 100))) enter('extension');
        break;

      case 'extension': {
        const range = b.high - b.low;
        const wick = b.high - Math.max(b.open, b.close);
        const toppingTail = range > 0 && b.close < b.open && b.high >= st.high * (1 - o.nearHigh) && wick / range >= o.rejectionWick;
        const stalled =
          st.barsSinceHigh >= o.stallBars &&
          b.close < b.open &&
          st.prev !== null &&
          st.prev.high >= st.high * (1 - o.stallNearHigh) &&
          b.close < st.prev.low;
        if (toppingTail || stalled) {
          st.rejection = toppingTail ? { high: b.high, low: b.low } : { high: st.high, low: b.low };
          enter('rejection');
        } else if (offHigh >= o.maxConfirmOffHighPct) {
          enter('fade'); // topped without a clean rejection; too late to call one now
        }
        break;
      }

      case 'rejection':
        if (b.high > st.rejection!.high) {
          st.rejection = null;
          enter('extension');
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
        } else if (offHigh >= o.fadeOffHighPct || (vwap !== null && b.close < vwap)) {
          enter('fade');
        }
        break;

      case 'fade':
        if (newHigh) {
          st.rejection = null;
          st.confirmLevel = null;
          enter('extension');
        } else if (vwap !== null && b.close < vwap && b.high >= vwap * (1 - o.vwapTouch)) {
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
    return st;
  }
}
