import type { Alert, AlertType, SymbolSnapshot, Trade } from '@deltascan/shared';

/** State of a symbol immediately before a trade was applied. */
export interface PriorState {
  high: number | null;
  low: number | null;
  last: number | null;
  vwap: number | null;
}

export interface AlertEngineOptions {
  /** Minimum ms between two alerts of the same type for the same symbol. */
  cooldownMs?: Partial<Record<AlertType, number>>;
  volumeSpikeMultiple?: number;
  blockMinShares?: number;
  blockMinNotional?: number;
  /** VWAP must be crossed by at least this fraction to count (filters chop). */
  vwapCrossBuffer?: number;
  /** A new high/low must clear the prior extreme by at least this fraction. */
  breakoutBuffer?: number;
  historySize?: number;
}

const DEFAULT_COOLDOWN_MS: Record<AlertType, number> = {
  new_high: 60_000,
  new_low: 60_000,
  vwap_reclaim: 45_000,
  vwap_loss: 45_000,
  volume_spike: 60_000,
  block_trade: 0,
  halt: 0,
  resume: 0,
  rejection_confirmed: 5 * 60_000,
  vwap_bounce: 5 * 60_000,
};

const REGULAR_SESSION_MINUTES = 390;
const WINDOW_SECONDS = 60;

/** Rolling 60-second volume using one-second buckets. */
class RollingVolume {
  private readonly buckets = new Float64Array(WINDOW_SECONDS);
  private lastSec = 0;
  sum = 0;

  add(timestampMs: number, size: number): void {
    const sec = Math.floor(timestampMs / 1000);
    if (sec !== this.lastSec) {
      const gap = Math.min(WINDOW_SECONDS, Math.max(0, sec - this.lastSec));
      for (let i = 1; i <= gap; i++) {
        const idx = (this.lastSec + i) % WINDOW_SECONDS;
        this.sum -= this.buckets[idx]!;
        this.buckets[idx] = 0;
      }
      this.lastSec = sec;
    }
    this.buckets[sec % WINDOW_SECONDS]! += size;
    this.sum += size;
  }
}

/**
 * Event-driven alerts ("Alert windows"). Each rule is edge-triggered: it fires when its
 * condition becomes true on a trade, then stays quiet for a per-symbol cooldown.
 */
export class AlertEngine {
  private readonly cooldownMs: Record<AlertType, number>;
  private readonly volumeSpikeMultiple: number;
  private readonly blockMinShares: number;
  private readonly blockMinNotional: number;
  private readonly vwapCrossBuffer: number;
  private readonly breakoutBuffer: number;
  private readonly historySize: number;

  private readonly lastFired = new Map<string, number>();
  private readonly volume = new Map<string, RollingVolume>();
  private pending: Alert[] = [];
  private readonly history: Alert[] = [];
  private seq = 0;

  constructor(opts: AlertEngineOptions = {}) {
    this.cooldownMs = { ...DEFAULT_COOLDOWN_MS, ...opts.cooldownMs };
    this.volumeSpikeMultiple = opts.volumeSpikeMultiple ?? 5;
    this.blockMinShares = opts.blockMinShares ?? 10_000;
    this.blockMinNotional = opts.blockMinNotional ?? 200_000;
    this.vwapCrossBuffer = opts.vwapCrossBuffer ?? 0.0005;
    this.breakoutBuffer = opts.breakoutBuffer ?? 0.001;
    this.historySize = opts.historySize ?? 500;
  }

  onTrade(t: Trade, prior: PriorState, snap: Readonly<SymbolSnapshot>): void {
    const { price } = t;

    if (prior.high !== null && price > prior.high * (1 + this.breakoutBuffer)) {
      this.fire('new_high', t, snap, `New high of day ${fmtPct(snap.changePct)}`, price);
    }
    if (prior.low !== null && price < prior.low * (1 - this.breakoutBuffer)) {
      this.fire('new_low', t, snap, `New low of day ${fmtPct(snap.changePct)}`, price);
    }

    if (prior.last !== null && prior.vwap !== null && snap.vwap !== null) {
      const buffer = snap.vwap * this.vwapCrossBuffer;
      if (prior.last < prior.vwap && price > snap.vwap + buffer) {
        this.fire('vwap_reclaim', t, snap, `Crossed above VWAP ${snap.vwap.toFixed(2)}`, snap.vwap);
      } else if (prior.last > prior.vwap && price < snap.vwap - buffer) {
        this.fire('vwap_loss', t, snap, `Crossed below VWAP ${snap.vwap.toFixed(2)}`, snap.vwap);
      }
    }

    let rolling = this.volume.get(t.symbol);
    if (!rolling) this.volume.set(t.symbol, (rolling = new RollingVolume()));
    rolling.add(t.timestamp, t.size);
    if (snap.avgVolume) {
      // Baseline is the faster of the normal pace and today's pace (RVOL), so a stock that is
      // already "in play" only alerts when volume accelerates again.
      const perMinute = (snap.avgVolume / REGULAR_SESSION_MINUTES) * Math.max(1, snap.rvol ?? 1);
      const multiple = rolling.sum / perMinute;
      if (multiple >= this.volumeSpikeMultiple) {
        this.fire('volume_spike', t, snap, `${multiple.toFixed(1)}× normal 1-min volume`, multiple);
      }
    }

    const notional = price * t.size;
    if (t.size >= this.blockMinShares && notional >= this.blockMinNotional) {
      this.fire('block_trade', t, snap, `${t.size.toLocaleString('en-US')} sh · ${fmtMoney(notional)}`, notional);
    }
  }

  /** Alerts detected by other components (e.g. halts), subject to the same cooldowns. */
  raise(
    type: AlertType,
    event: Pick<Trade, 'symbol' | 'price' | 'timestamp'>,
    changePct: number | null,
    detail: string,
  ): void {
    this.fire(type, event, { changePct }, detail);
  }

  /** Alerts raised since the last drain (for broadcasting). */
  drain(): Alert[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Most recent alerts, newest first (for clients that just connected). */
  recent(): Alert[] {
    return [...this.history].reverse();
  }

  private fire(
    type: AlertType,
    t: Pick<Trade, 'symbol' | 'price' | 'timestamp'>,
    snap: Pick<SymbolSnapshot, 'changePct'>,
    detail: string,
    value?: number,
  ): void {
    const key = `${t.symbol}:${type}`;
    const last = this.lastFired.get(key);
    if (last !== undefined && t.timestamp - last < this.cooldownMs[type]) return;
    this.lastFired.set(key, t.timestamp);

    const alert: Alert = {
      id: `${t.timestamp.toString(36)}-${(this.seq++).toString(36)}`,
      type,
      symbol: t.symbol,
      price: t.price,
      detail,
      value,
      changePct: snap.changePct,
      timestamp: t.timestamp,
    };
    this.pending.push(alert);
    this.history.push(alert);
    if (this.history.length > this.historySize) this.history.shift();
  }
}

function fmtPct(v: number | null): string {
  return v === null ? '' : `(${v >= 0 ? '+' : ''}${v.toFixed(1)}%)`;
}

function fmtMoney(v: number): string {
  return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1e3)}K`;
}
