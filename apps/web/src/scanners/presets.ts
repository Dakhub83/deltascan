import type { SymbolSnapshot } from '@deltascan/shared';
import { Gauge, List, Moon, Rocket, Sun, Sunrise, Target, TrendingDown, TrendingUp, Waves, Zap, type LucideIcon } from 'lucide-react';
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

export const PRESETS: ScannerPreset[] = [
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
