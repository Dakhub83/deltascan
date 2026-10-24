import type { HaltEvent, SymbolSnapshot, Trade, TradingStatus } from '@deltascan/shared';

export interface HaltTrackerOptions {
  /** Length of an LULD volatility pause (5 minutes on US exchanges). */
  luldPauseMs?: number;
  historySize?: number;
  onHalt?: (halt: HaltEvent) => void;
  onResume?: (halt: HaltEvent) => void;
}

const LULD_CODES = new Set(['LUDP', 'LUDS', 'M']);

/** Common SIP halt reason codes. Unknown codes fall back to the provider's text or the raw code. */
export const HALT_REASONS: Record<string, string> = {
  LUDP: 'Volatility pause (LULD)',
  LUDS: 'Volatility pause (LULD straddle)',
  M: 'Volatility pause',
  T1: 'News pending',
  T2: 'News released',
  T3: 'News & resumption times',
  T5: 'Single stock pause',
  T6: 'Extraordinary market activity',
  T8: 'ETF halt',
  T12: 'Additional info requested',
  H4: 'Non-compliance',
  H9: 'Not current in filings',
  H10: 'SEC trading suspension',
  H11: 'Regulatory concern',
  MWC1: 'Market-wide circuit breaker L1',
  MWC2: 'Market-wide circuit breaker L2',
  MWC3: 'Market-wide circuit breaker L3',
  IPO1: 'IPO not yet trading',
};

/**
 * Turns exchange trading-status messages into halt records ("Halts window"):
 * halt → (quoting) → resumed → first print sets the resume price and gap.
 */
export class HaltTracker {
  private readonly luldPauseMs: number;
  private readonly historySize: number;
  private readonly active = new Map<string, HaltEvent>();
  /** Resumed halts still waiting for their first print. */
  private readonly awaitingPrint = new Map<string, HaltEvent>();
  private readonly history: HaltEvent[] = [];
  private pending = new Map<string, HaltEvent>();
  private seq = 0;

  constructor(private readonly opts: HaltTrackerOptions = {}) {
    this.luldPauseMs = opts.luldPauseMs ?? 5 * 60_000;
    this.historySize = opts.historySize ?? 200;
  }

  isHalted(symbol: string): boolean {
    return this.active.has(symbol);
  }

  onStatus(status: TradingStatus, snap: Readonly<SymbolSnapshot> | undefined): void {
    const current = this.active.get(status.symbol);

    if (status.state === 'halted' || status.state === 'quoting') {
      if (current) {
        if (current.state !== status.state) this.update(current, { state: status.state });
        return;
      }
      const luld = LULD_CODES.has(status.reasonCode);
      const haltPrice = status.price ?? snap?.last ?? null;
      const halt: HaltEvent = {
        id: `${status.symbol}-${status.timestamp.toString(36)}-${(this.seq++).toString(36)}`,
        symbol: status.symbol,
        state: status.state,
        reasonCode: status.reasonCode,
        reason: status.reason ?? HALT_REASONS[status.reasonCode] ?? status.reasonCode,
        direction: luld ? (status.direction ?? direction(snap)) : null,
        haltedAt: status.timestamp,
        expectedResumeAt: luld ? status.timestamp + this.luldPauseMs : null,
        resumedAt: null,
        haltPrice,
        haltChangePct: haltPrice !== null && snap?.prevClose ? (haltPrice / snap.prevClose - 1) * 100 : null,
        resumePrice: null,
        resumeGapPct: null,
      };
      this.active.set(status.symbol, halt);
      this.history.push(halt);
      if (this.history.length > this.historySize) this.history.shift();
      this.pending.set(halt.id, halt);
      this.opts.onHalt?.(halt);
      return;
    }

    // Resumed
    if (!current) return;
    this.active.delete(status.symbol);
    this.update(current, { state: 'resumed', resumedAt: status.timestamp });
    if (status.price !== undefined) this.setResumePrice(current, status.price);
    else this.awaitingPrint.set(status.symbol, current);
    this.opts.onResume?.(current);
  }

  /** The first trade after a resumption is the re-open print. */
  onTrade(t: Trade): void {
    const halt = this.awaitingPrint.get(t.symbol);
    if (!halt) return;
    this.awaitingPrint.delete(t.symbol);
    this.setResumePrice(halt, t.price);
  }

  /** Halts created or changed since the last drain. */
  drain(): HaltEvent[] {
    if (!this.pending.size) return [];
    const out = [...this.pending.values()].map((h) => ({ ...h }));
    this.pending = new Map();
    return out;
  }

  /** Today's halts, newest first. */
  recent(): HaltEvent[] {
    return this.history.map((h) => ({ ...h })).reverse();
  }

  private setResumePrice(halt: HaltEvent, price: number): void {
    this.update(halt, {
      resumePrice: price,
      resumeGapPct: halt.haltPrice ? (price / halt.haltPrice - 1) * 100 : null,
    });
  }

  private update(halt: HaltEvent, patch: Partial<HaltEvent>): void {
    Object.assign(halt, patch);
    this.pending.set(halt.id, halt);
  }
}

/** Which LULD band was hit, judged from the move right before the pause. */
function direction(snap: Readonly<SymbolSnapshot> | undefined): 'up' | 'down' | null {
  const move = snap?.chg5mPct ?? snap?.chg1mPct ?? null;
  if (move === null || move === 0) return null;
  return move > 0 ? 'up' : 'down';
}
