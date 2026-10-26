/** A trader's hard limits for one short position. */
export interface ShortLimits {
  /** Max dollar loss on the whole position if the stop is hit. Every add must keep total risk under this. */
  maxRisk: number;
  maxShares: number;
  maxLots: number;
  /** After each add, the whole-position stop moves to that lot's entry plus this. */
  addStopOffset: number;
  /** DAS hotkey stop-limit offset from average cost. */
  hotkeyOffset: number;
  /** Before the 09:30 open, total shares are capped here (a probe, not a position). */
  premarketMaxShares: number;
  /** First stops closer than this to the entry get a warning. */
  minStopDistance: number;
}

export const DEFAULT_SHORT_LIMITS: ShortLimits = {
  maxRisk: 100,
  maxShares: 2_000,
  maxLots: 4,
  addStopOffset: 0.1,
  hotkeyOffset: 0.03,
  premarketMaxShares: 100,
  minStopDistance: 0.05,
};

export interface PlannedLot {
  entry: number;
  shares: number;
  /** Whole-position stop once this lot is on. */
  stop: number;
  totalShares: number;
  avgCost: number;
  /** Dollar loss if `stop` is hit. Negative means the stop locks in a gain. */
  openRisk: number;
}

export type PlanWarning =
  | { kind: 'premarket'; text: string }
  | { kind: 'tight-stop'; text: string }
  | { kind: 'too-many-lots'; text: string }
  | { kind: 'averaging-up'; text: string }
  | { kind: 'no-budget'; text: string }
  | { kind: 'share-cap'; text: string };

export interface ShortPlan {
  lots: PlannedLot[];
  warnings: PlanWarning[];
  /** For the final position: DAS buy-to-cover stop-limit and the mirrored long exit. */
  hotkeys: { coverStop: number; longExit: number } | null;
  error: string | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;
/** Floors a share count, tolerating float error: 100 / (5.20 − 5.00) is 499.999…, which should be 500. */
const wholeShares = (n: number) => Math.floor(n + 1e-6);
const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Sizes a short and its planned adds so the whole position never risks more than `maxRisk`.
 * Lot 1 uses the trader's stop; each add moves the stop on everything to that add's entry
 * + `addStopOffset`. On a fading stock that locks gains on earlier lots, which is the risk
 * budget the next add uses.
 */
export function planShort(
  input: { stop: number; entries: number[]; premarket: boolean; spread?: number | null },
  limits: ShortLimits,
): ShortPlan {
  const warnings: PlanWarning[] = [];
  const entries = input.entries.filter((e) => Number.isFinite(e) && e > 0);
  if (!entries.length) return { lots: [], warnings, hotkeys: null, error: 'Enter a first entry price.' };
  if (!(input.stop > entries[0]!)) return { lots: [], warnings, hotkeys: null, error: 'For a short, the stop must be above the first entry.' };

  const shareCap = input.premarket ? Math.min(limits.premarketMaxShares, limits.maxShares) : limits.maxShares;
  if (input.premarket) {
    warnings.push({ kind: 'premarket', text: `Pre-market: probe only, capped at ${shareCap} shares in total. Scale after 9:30.` });
  }

  const firstDistance = input.stop - entries[0]!;
  if (firstDistance < limits.minStopDistance) {
    warnings.push({ kind: 'tight-stop', text: `Stop is only ${money(firstDistance)} above the entry (your minimum is ${money(limits.minStopDistance)}).` });
  }
  if (input.spread && firstDistance < 2 * input.spread) {
    warnings.push({ kind: 'tight-stop', text: `Stop is within 2× the current spread (${money(input.spread)}); normal noise can hit it.` });
  }
  if (entries.length > limits.maxLots) {
    warnings.push({ kind: 'too-many-lots', text: `${entries.length} lots planned; your limit is ${limits.maxLots}.` });
  }

  const lots: PlannedLot[] = [];
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k]!;
    const stop = k === 0 ? input.stop : cents(entry + limits.addStopOffset);
    if (k > 0 && entry >= entries[k - 1]!) {
      warnings.push({ kind: 'averaging-up', text: `Add ${k} at ${money(entry)} is not below the previous entry: that's averaging up, not pyramiding.` });
    }
    const prevShares = lots.reduce((s, l) => s + l.shares, 0);
    const prevRiskAtNewStop = lots.reduce((s, l) => s + l.shares * (stop - l.entry), 0);
    const budget = limits.maxRisk - prevRiskAtNewStop;
    const perShare = stop - entry;
    const byRisk = budget > 0 && perShare > 0 ? wholeShares(budget / perShare) : 0;
    const byCap = Math.max(0, shareCap - prevShares);
    const shares = Math.min(byRisk, byCap);

    if (shares === 0) {
      warnings.push(
        byCap === 0
          ? { kind: 'share-cap', text: `${k === 0 ? 'Entry' : `Add ${k}`}: share cap of ${shareCap} already reached.` }
          : { kind: 'no-budget', text: `${k === 0 ? 'Entry' : `Add ${k}`}: no risk budget left at a ${money(stop)} stop.` },
      );
    } else if (byCap < byRisk && k === entries.length - 1) {
      warnings.push({ kind: 'share-cap', text: `Sized by your ${shareCap}-share cap, not by risk.` });
    }

    const totalShares = prevShares + shares;
    const cost = lots.reduce((s, l) => s + l.shares * l.entry, 0) + shares * entry;
    lots.push({
      entry,
      shares,
      stop,
      totalShares,
      avgCost: totalShares ? cost / totalShares : entry,
      openRisk: prevRiskAtNewStop + shares * perShare,
    });
  }

  const last = lots.at(-1)!;
  const hotkeys = last.totalShares
    ? { coverStop: cents(last.avgCost + limits.hotkeyOffset), longExit: cents(last.avgCost - limits.hotkeyOffset) }
    : null;
  return { lots, warnings, hotkeys, error: null };
}
