import type { ColDef, ValueGetterParams } from 'ag-grid-community';
import type { SymbolSnapshot } from '@deltascan/shared';
import { fmtCompact, fmtPct, fmtPrice } from '../lib/format';
import { ChangeCell, FloatCell, PriceCell, RangeCell, RvolCell, StageCell, SymbolCell, TierCell, type Tier } from './cells';
import { STAGE_META, minutesSinceHigh, offHighPct } from './fade';

type Col = ColDef<SymbolSnapshot>;
type Getter = (s: SymbolSnapshot) => number | null;

const pctOf = (a: number | null, b: number | null) => (a != null && b ? ((a - b) / b) * 100 : null);

/** Metrics derived client-side from the snapshot. */
export const derived = {
  fromOpenPct: (s) => pctOf(s.last, s.open),
  vwapDistPct: (s) => pctOf(s.last, s.vwap),
  hodDistPct: (s) => (s.last != null && s.high ? ((s.high - s.last) / s.high) * 100 : null),
  spreadPct: (s) => (s.bid && s.ask && s.ask >= s.bid ? ((s.ask - s.bid) / ((s.ask + s.bid) / 2)) * 100 : null),
  dollarVolume: (s) => (s.vwap != null ? s.vwap * s.volume : null),
} satisfies Record<string, Getter>;

/** Tier thresholds; checked in this order, so a sub-$1 low-float stock is tagged sub-$1. */
export const TIERS = { subDollarBelow: 1, lowFloatBelow: 20e6, largeCapAbove: 10e9 };

export function tierOf(s: SymbolSnapshot): Tier | null {
  if (s.last != null && s.last < TIERS.subDollarBelow) return 'sub-dollar';
  if (s.floatShares != null && s.floatShares < TIERS.lowFloatBelow) return 'low-float';
  if (s.marketCap != null && s.marketCap > TIERS.largeCapAbove) return 'large-cap';
  return null;
}

const getter = (fn: Getter) => (p: ValueGetterParams<SymbolSnapshot>) => (p.data ? fn(p.data) : null);

const num: Partial<Col> = { type: 'rightAligned', cellClass: 'num', sortingOrder: ['desc', 'asc', null] };
const pctFmt = { valueFormatter: (p: { value: number | null }) => fmtPct(p.value) };

export const COLUMNS = {
  symbol: {
    colId: 'symbol', field: 'symbol', headerName: 'Symbol', pinned: 'left', width: 116, cellRenderer: SymbolCell,
    sortingOrder: ['asc', 'desc', null], lockPinned: true,
  },
  name: { colId: 'name', field: 'name', headerName: 'Company', width: 150, cellClass: 'text-dim' },
  sector: { colId: 'sector', field: 'sector', headerName: 'Sector', width: 110, cellClass: 'text-dim' },
  last: { ...num, colId: 'last', field: 'last', headerName: 'Price', width: 82, cellRenderer: PriceCell },
  changePct: { ...num, colId: 'changePct', field: 'changePct', headerName: 'Chg %', width: 86, cellRenderer: ChangeCell },
  chg1mPct: { ...num, ...pctFmt, colId: 'chg1mPct', field: 'chg1mPct', headerName: '1m %', width: 72, cellClassRules: signRules() },
  chg5mPct: { ...num, ...pctFmt, colId: 'chg5mPct', field: 'chg5mPct', headerName: '5m %', width: 72, cellClassRules: signRules() },
  fadeStage: {
    colId: 'fadeStage', headerName: 'Setup', width: 132, sortingOrder: ['asc', 'desc', null],
    valueGetter: (p: ValueGetterParams<SymbolSnapshot>) => (p.data?.fade ? STAGE_META[p.data.fade.stage].order : null),
    cellRenderer: StageCell,
  },
  offHighPct: {
    ...num, colId: 'offHighPct', headerName: 'Off High', width: 80, sortingOrder: ['asc', 'desc', null],
    valueGetter: getter(offHighPct), valueFormatter: (p) => (p.value == null ? '—' : `-${p.value.toFixed(1)}%`),
    cellClassRules: { 'text-down': (p) => (p.value ?? 0) >= 8 },
  },
  sinceHighMin: {
    ...num, colId: 'sinceHighMin', headerName: 'Since High', width: 84, sortingOrder: ['asc', 'desc', null],
    valueGetter: getter((s) => minutesSinceHigh(s)), valueFormatter: (p) => (p.value == null ? '—' : `${Math.floor(p.value)}m`),
    cellClass: 'num text-dim',
  },
  tier: {
    colId: 'tier', headerName: 'Type', width: 78, sortable: false,
    valueGetter: (p: ValueGetterParams<SymbolSnapshot>) => (p.data ? tierOf(p.data) : null), cellRenderer: TierCell,
  },
  preChangePct: { ...num, ...pctFmt, colId: 'preChangePct', field: 'preChangePct', headerName: 'PM Chg %', width: 86, cellRenderer: ChangeCell },
  preVolume: { ...num, colId: 'preVolume', field: 'preVolume', headerName: 'PM Vol', width: 78, valueFormatter: (p) => fmtCompact(p.value) },
  preHigh: { ...num, colId: 'preHigh', field: 'preHigh', headerName: 'PM High', width: 78, valueFormatter: (p) => fmtPrice(p.value), cellClass: 'num text-dim' },
  regularClose: {
    ...num, colId: 'regularClose', field: 'regularClose', headerName: 'Close', width: 78,
    valueFormatter: (p) => fmtPrice(p.value), cellClass: 'num text-dim',
  },
  postChangePct: { ...num, ...pctFmt, colId: 'postChangePct', field: 'postChangePct', headerName: 'AH Chg %', width: 86, cellRenderer: ChangeCell },
  postVolume: { ...num, colId: 'postVolume', field: 'postVolume', headerName: 'AH Vol', width: 78, valueFormatter: (p) => fmtCompact(p.value) },
  gapPct: { ...num, ...pctFmt, colId: 'gapPct', field: 'gapPct', headerName: 'Gap %', width: 78, cellClassRules: signRules() },
  fromOpenPct: {
    ...num, ...pctFmt, colId: 'fromOpenPct', headerName: 'From Open', width: 86,
    valueGetter: getter(derived.fromOpenPct), cellClassRules: signRules(),
  },
  volume: { ...num, colId: 'volume', field: 'volume', headerName: 'Volume', width: 80, valueFormatter: (p) => fmtCompact(p.value) },
  dollarVolume: {
    ...num, colId: 'dollarVolume', headerName: '$ Vol', width: 78,
    valueGetter: getter(derived.dollarVolume), valueFormatter: (p) => (p.value == null ? '—' : `$${fmtCompact(p.value)}`),
  },
  rvol: { ...num, colId: 'rvol', field: 'rvol', headerName: 'RVOL', width: 104, cellRenderer: RvolCell },
  floatShares: { ...num, colId: 'floatShares', field: 'floatShares', headerName: 'Float', width: 74, cellRenderer: FloatCell },
  marketCap: {
    ...num, colId: 'marketCap', field: 'marketCap', headerName: 'Mkt Cap', width: 80,
    valueFormatter: (p) => fmtCompact(p.value), cellClass: 'num text-dim',
  },
  shortInterestPct: {
    ...num, colId: 'shortInterestPct', field: 'shortInterestPct', headerName: 'Short %', width: 74,
    valueFormatter: (p) => (p.value == null ? '—' : `${p.value.toFixed(1)}%`),
    cellClassRules: { 'text-warn': (p) => (p.value ?? 0) >= 20 },
  },
  vwapDistPct: {
    ...num, ...pctFmt, colId: 'vwapDistPct', headerName: 'vs VWAP', width: 80,
    valueGetter: getter(derived.vwapDistPct), cellClassRules: signRules(),
  },
  hodDistPct: {
    ...num, colId: 'hodDistPct', headerName: 'From HOD', width: 82, sortingOrder: ['asc', 'desc', null],
    valueGetter: getter(derived.hodDistPct),
    valueFormatter: (p) => (p.value == null ? '—' : p.value < 0.005 ? 'AT HOD' : `-${p.value.toFixed(2)}%`),
    cellClassRules: { 'text-up font-semibold': (p) => p.value != null && p.value < 0.005 },
  },
  range: { colId: 'range', headerName: 'Day Range', width: 110, sortable: false, cellRenderer: RangeCell },
  vwap: { ...num, colId: 'vwap', field: 'vwap', headerName: 'VWAP', width: 78, valueFormatter: (p) => fmtPrice(p.value), cellClass: 'num text-dim' },
  high: { ...num, colId: 'high', field: 'high', headerName: 'High', width: 76, valueFormatter: (p) => fmtPrice(p.value), cellClass: 'num text-dim' },
  low: { ...num, colId: 'low', field: 'low', headerName: 'Low', width: 76, valueFormatter: (p) => fmtPrice(p.value), cellClass: 'num text-dim' },
  spreadPct: {
    ...num, colId: 'spreadPct', headerName: 'Spread', width: 72, sortingOrder: ['asc', 'desc', null],
    valueGetter: getter(derived.spreadPct),
    valueFormatter: (p) => (p.value == null ? '—' : `${p.value.toFixed(2)}%`), cellClass: 'num text-dim',
  },
} satisfies Record<string, Col>;

export type ColumnId = keyof typeof COLUMNS;
export const ALL_COLUMN_IDS = Object.keys(COLUMNS) as ColumnId[];

function signRules(): Col['cellClassRules'] {
  return {
    'text-up': (p) => (p.value ?? 0) > 0,
    'text-down': (p) => (p.value ?? 0) < 0,
  };
}
