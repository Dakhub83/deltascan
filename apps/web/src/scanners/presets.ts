import type { SymbolSnapshot } from '@deltascan/shared';
import { ArrowDownRight, ArrowUpFromLine, ChevronsUp, CircleDollarSign, Flame, Gauge, List, Moon, Rocket, Sun, Sunrise, Target, TrendingDown, TrendingUp, Undo2, Waves, Zap, type LucideIcon } from 'lucide-react';
import { FADE, passesFloors } from './fade';
import { derived, type ColumnId } from './columns';

export interface ScannerPreset {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  filter: (s: SymbolSnapshot) => boolean;
  sort: { colId: ColumnId; sort: 'asc' | 'desc' };
  columns: ColumnId[];
  /** Shown when nothing matches; defaults to a generic message. */
  emptyText?: string;
}

const n = (v: number | null | undefined) => v ?? Number.NaN;

/** Extended-hours scans. Volume floors keep a single odd print from qualifying. */
export const EXTENDED = { preMinChangePct: 3, preMinVolume: 10_000, postMinMovePct: 2, postMinVolume: 5_000 };

/** Multi-strategy momentum scan: every condition must hold. */
export const MOMENTUM = { minChangePct: 5, minRvol: 2, maxHodDistPct: 2, min5mPct: 0 };

/**
 * Bullish momentum scans in the style of Trade Ideas' strategies. For a short seller they're
 * the early warning: these are the runners that become tomorrow's (or the next hour's) fades.
 */
export const BULLISH = {
  newHighRvol: 2,
  newHighWithinPct: 0.5,
  up5mUsd: 0.5,
  fastMaxPrice: 20,
  fastMinPrice: 1,
  fast5mPct: 3,
  turbo1mPct: 2,
  turboRvol: 2,
  turboHodPct: 1,
  /** A real selloff first: the low at least this far under the open and the prior close… */
  bottomDropPct: 3,
  /** …then up at least this far off it, still this far under the high, and rising over 5m. */
  bottomBouncePct: 3,
  bottomUnderHighPct: 3,
};

const pctUnder = (low: number | null, ref: number | null) => (low != null && ref ? ((ref - low) / ref) * 100 : Number.NaN);

export const PRESETS: ScannerPreset[] = [
  {
    id: 'fade-setups',
    title: 'Fade Setups',
    description: `Runners past the spike, ranked by setup stage · price ≥ $${FADE.minPrice}, any float`,
    icon: ArrowDownRight,
    filter: (s) => s.fade !== null && s.fade.stage !== 'spike' && passesFloors(s),
    // Confirmed rejections first: those are the ones you can act on.
    sort: { colId: 'fadeStage', sort: 'asc' },
    columns: ['symbol', 'fadeStage', 'last', 'changePct', 'offHighPct', 'sinceHighMin', 'vwapDistPct', 'floatShares', 'rvol', 'tier'],
    emptyText: 'No runner has spiked 15%+ and extended yet. Setups appear here as they form.',
  },
  {
    id: 'backside-vwap',
    title: 'Backside VWAP',
    description: 'Broken runners below VWAP, closest to it first: bounce-into-VWAP shorts',
    icon: Undo2,
    filter: (s) =>
      (s.fade?.stage === 'fade' || s.fade?.stage === 'vwap-bounce') && s.vwap != null && s.last != null && s.last < s.vwap && passesFloors(s),
    sort: { colId: 'vwapDistPct', sort: 'desc' },
    columns: ['symbol', 'fadeStage', 'last', 'vwapDistPct', 'vwap', 'offHighPct', 'changePct', 'sinceHighMin', 'floatShares'],
    emptyText: 'No broken runner is trading under VWAP right now.',
  },
  {
    id: 'momentum',
    title: 'Momentum',
    description: `Up ≥ ${MOMENTUM.minChangePct}%, RVOL ≥ ${MOMENTUM.minRvol}×, within ${MOMENTUM.maxHodDistPct}% of HOD, rising over 5m`,
    icon: Zap,
    filter: (s) =>
      !s.halted &&
      n(s.changePct) >= MOMENTUM.minChangePct &&
      n(s.rvol) >= MOMENTUM.minRvol &&
      n(derived.hodDistPct(s)) <= MOMENTUM.maxHodDistPct &&
      n(s.chg5mPct) > MOMENTUM.min5mPct,
    // Ranked by what's moving now, not by who ran earlier in the day.
    sort: { colId: 'chg5mPct', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'chg1mPct', 'chg5mPct', 'changePct', 'rvol', 'floatShares', 'hodDistPct', 'volume'],
  },
  {
    id: 'new-highs-rvol',
    title: 'New Highs on 2× RV',
    description: `At the high of day (within ${BULLISH.newHighWithinPct}%) on RVOL ≥ ${BULLISH.newHighRvol}×, up on the day`,
    icon: ChevronsUp,
    filter: (s) =>
      !s.halted && n(derived.hodDistPct(s)) <= BULLISH.newHighWithinPct && n(s.rvol) >= BULLISH.newHighRvol && n(s.changePct) > 0,
    sort: { colId: 'rvol', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'hodDistPct', 'rvol', 'changePct', 'chg5mPct', 'floatShares', 'volume'],
    emptyText: 'Nothing is at its high on heavy volume right now.',
  },
  {
    id: 'up-50c-5m',
    title: 'Up 50¢ in 5 Min',
    description: `Up at least $${BULLISH.up5mUsd.toFixed(2)} over the last 5 minutes`,
    icon: CircleDollarSign,
    filter: (s) => !s.halted && n(derived.chg5mUsd(s)) >= BULLISH.up5mUsd,
    sort: { colId: 'chg5mUsd', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'chg5mUsd', 'chg5mPct', 'changePct', 'rvol', 'hodDistPct', 'floatShares'],
  },
  {
    id: 'under-20-fast',
    title: 'Under $20 Moving Up Fast',
    description: `$${BULLISH.fastMinPrice}–$${BULLISH.fastMaxPrice}, up ≥ ${BULLISH.fast5mPct}% in 5 min and still rising`,
    icon: Gauge,
    filter: (s) =>
      !s.halted &&
      n(s.last) >= BULLISH.fastMinPrice &&
      n(s.last) <= BULLISH.fastMaxPrice &&
      n(s.chg5mPct) >= BULLISH.fast5mPct &&
      n(s.chg1mPct) > 0,
    sort: { colId: 'chg5mPct', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'chg1mPct', 'chg5mPct', 'changePct', 'rvol', 'floatShares', 'hodDistPct'],
  },
  {
    id: 'turbo-breaks-up',
    title: 'Turbo Breaks Up',
    description: `Up ≥ ${BULLISH.turbo1mPct}% in the last minute, at the high (within ${BULLISH.turboHodPct}%), RVOL ≥ ${BULLISH.turboRvol}×`,
    icon: Flame,
    filter: (s) =>
      !s.halted &&
      n(s.chg1mPct) >= BULLISH.turbo1mPct &&
      n(derived.hodDistPct(s)) <= BULLISH.turboHodPct &&
      n(s.rvol) >= BULLISH.turboRvol,
    sort: { colId: 'chg1mPct', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'chg1mPct', 'chg5mPct', 'changePct', 'rvol', 'hodDistPct', 'floatShares'],
    emptyText: 'No sudden one-minute breakout right now.',
  },
  {
    id: 'rallying-off-bottom',
    title: 'Rallying off the Bottom',
    description: `Sold off ≥ ${BULLISH.bottomDropPct}% under the open and prior close, now ≥ ${BULLISH.bottomBouncePct}% off the low and rising`,
    icon: ArrowUpFromLine,
    filter: (s) =>
      !s.halted &&
      pctUnder(s.low, s.open) >= BULLISH.bottomDropPct &&
      pctUnder(s.low, s.prevClose) >= BULLISH.bottomDropPct &&
      n(derived.offLowPct(s)) >= BULLISH.bottomBouncePct &&
      n(derived.hodDistPct(s)) >= BULLISH.bottomUnderHighPct &&
      n(s.chg5mPct) > 0,
    sort: { colId: 'offLowPct', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'offLowPct', 'low', 'changePct', 'chg5mPct', 'hodDistPct', 'rvol'],
  },
  {
    id: 'premarket-gainers',
    title: 'Pre-market Gainers',
    description: `Up ≥ ${EXTENDED.preMinChangePct}% before the open on ≥ ${EXTENDED.preMinVolume / 1000}K shares`,
    icon: Sun,
    filter: (s) => n(s.preChangePct) >= EXTENDED.preMinChangePct && s.preVolume >= EXTENDED.preMinVolume,
    sort: { colId: 'preChangePct', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'preChangePct', 'preVolume', 'preHigh', 'floatShares', 'shortInterestPct', 'chg5mPct'],
    emptyText: 'Pre-market trades come in from 4:00 to 9:30 ET. On simulated data, set MOCK_SESSION=pre in .env.',
  },
  {
    id: 'after-hours-movers',
    title: 'After-hours Movers',
    description: `Moved ≥ ${EXTENDED.postMinMovePct}% either way since the 4 pm close`,
    icon: Moon,
    filter: (s) => Math.abs(n(s.postChangePct)) >= EXTENDED.postMinMovePct && s.postVolume >= EXTENDED.postMinVolume,
    sort: { colId: 'postChangePct', sort: 'desc' },
    columns: ['symbol', 'tier', 'last', 'postChangePct', 'postVolume', 'regularClose', 'changePct', 'floatShares', 'chg5mPct'],
    emptyText: 'After-hours trades come in from 16:00 to 20:00 ET. On simulated data, set MOCK_SESSION=post in .env.',
  },
  {
    id: 'top-gainers',
    title: 'Top Gainers',
    description: 'Up on the day, ranked by % change',
    icon: TrendingUp,
    filter: (s) => n(s.changePct) > 0,
    sort: { colId: 'changePct', sort: 'desc' },
    columns: ['symbol', 'last', 'changePct', 'volume', 'rvol', 'floatShares', 'gapPct', 'range'],
  },
  {
    id: 'top-losers',
    title: 'Top Losers',
    description: 'Down on the day, ranked by % change',
    icon: TrendingDown,
    filter: (s) => n(s.changePct) < 0,
    sort: { colId: 'changePct', sort: 'asc' },
    columns: ['symbol', 'last', 'changePct', 'volume', 'rvol', 'floatShares', 'gapPct', 'range'],
  },
  {
    id: 'gap-ups',
    title: 'Gap Ups',
    description: 'Opened ≥ 3% above prior close',
    icon: Sunrise,
    filter: (s) => n(s.gapPct) >= 3,
    sort: { colId: 'gapPct', sort: 'desc' },
    columns: ['symbol', 'last', 'gapPct', 'fromOpenPct', 'changePct', 'volume', 'rvol', 'floatShares'],
  },
  {
    id: 'high-rvol',
    title: 'High Relative Volume',
    description: 'Trading ≥ 2× normal volume for this time of day',
    icon: Gauge,
    filter: (s) => n(s.rvol) >= 2,
    sort: { colId: 'rvol', sort: 'desc' },
    columns: ['symbol', 'last', 'changePct', 'rvol', 'volume', 'dollarVolume', 'floatShares', 'vwapDistPct'],
  },
  {
    id: 'low-float-runners',
    title: 'Low Float Runners',
    description: 'Float < 30M, up ≥ 10% — small-cap momentum',
    icon: Rocket,
    filter: (s) => n(s.floatShares) < 30e6 && n(s.changePct) >= 10,
    sort: { colId: 'changePct', sort: 'desc' },
    columns: ['symbol', 'last', 'changePct', 'floatShares', 'rvol', 'shortInterestPct', 'hodDistPct', 'volume'],
  },
  {
    id: 'near-hod',
    title: 'Near High of Day',
    description: 'Within 1% of HOD and up ≥ 2%',
    icon: Target,
    filter: (s) => n(derived.hodDistPct(s)) <= 1 && n(s.changePct) >= 2,
    sort: { colId: 'hodDistPct', sort: 'asc' },
    columns: ['symbol', 'last', 'hodDistPct', 'changePct', 'rvol', 'vwapDistPct', 'volume', 'range'],
  },
  {
    id: 'vwap-leaders',
    title: 'VWAP Leaders',
    description: 'Holding above VWAP, ranked by distance',
    icon: Waves,
    filter: (s) => n(derived.vwapDistPct(s)) > 0 && n(s.changePct) > 0,
    sort: { colId: 'vwapDistPct', sort: 'desc' },
    columns: ['symbol', 'last', 'vwapDistPct', 'vwap', 'changePct', 'rvol', 'volume', 'range'],
  },
  {
    id: 'all',
    title: 'Full Watchlist',
    description: 'Every streamed symbol',
    icon: List,
    filter: () => true,
    sort: { colId: 'symbol', sort: 'asc' },
    columns: ['symbol', 'name', 'last', 'changePct', 'volume', 'rvol', 'floatShares', 'marketCap', 'sector'],
  },
];

export const PRESETS_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
