import type { Bar, Trade } from '@deltascan/shared';

export interface RadarOptions {
  /** A stock whose price moved at least this much (either way) inside the window is a candidate. */
  minMovePct: number;
  windowMs: number;
  /** Dollars traded inside the window; keeps a lone odd-lot print from looking like a move. */
  minNotional: number;
}

export const DEFAULT_RADAR: RadarOptions = { minMovePct: 4, windowMs: 5 * 60_000, minNotional: 5_000 };

interface MiniBar {
  t: number;
  o: number;
  c: number;
  notional: number;
}

/** Symbols not heard from for this long are forgotten, so the map stays at today's actives. */
const FORGET_MS = 30 * 60_000;
const MINUTE = 60_000;

/**
 * Watches every symbol's 1-minute bars (Alpaca's wildcard bar subscription is free on the iex
 * plan) and scores how fast each is moving right now, so the few live trade slots can go to the
 * stocks that are actually running, whether or not they're on the gainers list yet.
 */
export class MoverRadar {
  private readonly bars = new Map<string, MiniBar[]>();

  constructor(private readonly opts: RadarOptions = DEFAULT_RADAR) {}

  onBar(b: Bar): void {
    let list = this.bars.get(b.symbol);
    if (!list) this.bars.set(b.symbol, (list = []));
    const bar = { t: b.timestamp, o: b.open, c: b.close, notional: (b.vwap ?? b.close) * b.volume };
    const last = list[list.length - 1];
    if (last && last.t === bar.t) list[list.length - 1] = bar;
    else if (!last || bar.t > last.t) list.push(bar);
    // One bar older than the window is kept: its close is where the window's move starts.
    const cutoff = bar.t - this.opts.windowMs;
    while (list.length > 2 && list[1]!.t < cutoff) list.shift();
  }

  /**
   * % move over the window ending with the latest bar, from the close before the window (or the
   * first bar's open when the stock had no earlier bar). Null when the stock is quiet, thin or
   * hasn't traded in the window.
   */
  move(symbol: string, now: number): number | null {
    const list = this.bars.get(symbol);
    const last = list?.[list.length - 1];
    // A bar is stamped with its start; it is complete a minute later.
    if (!list || !last || now - (last.t + MINUTE) > this.opts.windowMs) return null;
    const start = last.t - this.opts.windowMs;
    const inWindow = list.filter((b) => b.t > start);
    if (inWindow.reduce((sum, b) => sum + b.notional, 0) < this.opts.minNotional) return null;
    const before = list.filter((b) => b.t <= start).pop();
    const from = before ? before.c : inWindow[0]!.o;
    return from > 0 ? (last.c / from - 1) * 100 : null;
  }

  /** Symbols moving at least `minMovePct`, the biggest move (up or down) first. */
  candidates(now: number): { symbol: string; movePct: number }[] {
    const out: { symbol: string; movePct: number }[] = [];
    for (const [symbol, list] of this.bars) {
      if (now - list[list.length - 1]!.t > FORGET_MS) {
        this.bars.delete(symbol);
        continue;
      }
      const movePct = this.move(symbol, now);
      if (movePct !== null && Math.abs(movePct) >= this.opts.minMovePct) out.push({ symbol, movePct });
    }
    return out.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
  }

  /** How hard the symbol is moving now (|% move|), 0 when quiet. */
  heat(symbol: string, now: number): number {
    return Math.abs(this.move(symbol, now) ?? 0);
  }

  get size(): number {
    return this.bars.size;
  }
}

export interface LivePlan {
  add: string[];
  drop: string[];
}

/**
 * Which tracked symbols get the live trade slots. Free slots go to the hottest symbols; when
 * full, a symbol takes the slot of the coldest live one only if it is clearly hotter
 * (`swapMargin` points of % move) and that one has had its slot for `minLiveMs`, so two stocks
 * of similar heat don't swap back and forth every minute.
 */
export function planLive(opts: {
  live: ReadonlyMap<string, number>; // symbol → when it went live
  tracked: readonly string[]; // in priority order when heat ties (e.g. gainers rank)
  pinned: ReadonlySet<string>;
  slots: number;
  heat: (symbol: string) => number;
  now: number;
  minLiveMs: number;
  swapMargin: number;
}): LivePlan {
  const { live, pinned, slots, heat, now } = opts;
  const order = new Map(opts.tracked.map((s, i) => [s, i]));
  const waiting = opts.tracked
    .filter((s) => !live.has(s) && !pinned.has(s))
    .sort((a, b) => heat(b) - heat(a) || order.get(a)! - order.get(b)!);
  const rotating = [...live.keys()].filter((s) => !pinned.has(s));
  const add: string[] = [];
  const drop: string[] = [];
  let free = slots - live.size;
  for (const s of waiting) {
    if (free > 0) {
      add.push(s);
      free--;
      continue;
    }
    const coldest = rotating
      .filter((r) => !drop.includes(r) && now - live.get(r)! >= opts.minLiveMs)
      .sort((a, b) => heat(a) - heat(b))[0];
    if (!coldest || heat(s) < heat(coldest) + opts.swapMargin) break;
    drop.push(coldest);
    add.push(s);
  }
  return { add, drop };
}

/**
 * A bar as prints, for symbols followed by bars only: the store and alerts then see the
 * minute's open, extremes (in the likely order) and close. Volume is split evenly, so VWAP is
 * approximate until the symbol is live again.
 */
export function barPrints(b: Bar): Trade[] {
  const size = Math.max(1, Math.round(b.volume / 4));
  const [first, second] = b.close >= b.open ? [b.low, b.high] : [b.high, b.low];
  return [b.open, first, second, b.close].map((price, i) => ({
    symbol: b.symbol,
    price,
    size,
    timestamp: b.timestamp + [0, 15_000, 30_000, 59_000][i]!,
  }));
}
