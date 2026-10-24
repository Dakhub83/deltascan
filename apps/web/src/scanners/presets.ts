import type { SymbolSnapshot } from '@deltascan/shared';
import { Gauge, List, Rocket, Sunrise, Target, TrendingDown, TrendingUp, Waves, type LucideIcon } from 'lucide-react';
import { derived, type ColumnId } from './columns';

export interface ScannerPreset {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  filter: (s: SymbolSnapshot) => boolean;
  sort: { colId: ColumnId; sort: 'asc' | 'desc' };
  columns: ColumnId[];
}

const n = (v: number | null | undefined) => v ?? Number.NaN;

export const PRESETS: ScannerPreset[] = [
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
