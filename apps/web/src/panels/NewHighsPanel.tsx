import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, RowClassParams } from 'ag-grid-community';
import type { IDockviewPanelProps } from 'dockview';
import { DollarSign, Eraser, Flame, Layers, List, Trophy } from 'lucide-react';
import clsx from 'clsx';
import { gridTheme } from '../lib/gridTheme';
import { marketData } from '../lib/marketData';
import { fmtCompact, fmtMultiple, fmtPct, fmtPrice, fmtTimeET } from '../lib/format';
import { openQuoteFor, requestLayoutSave, symbolDoubleClick } from '../lib/layout';
import { fmtAgo, isQuiet, lastNhodBySymbol, nhodLeaders, nhodRows, passesNhodFilter, QUIET_AFTER_MS, STREAK_WINDOW_MS, type NhodRow } from '../lib/newHighs';
import { isActive, rangeLabel, type PriceRange } from '../scanners/priceRange';
import { floatLabel, type FloatRange } from '../scanners/floatRange';
import { useUiStore } from '../store/uiStore';
import { IconButton, MenuItem, MenuLabel, Popover } from '../components/Popover';
import { FLOAT_KIND, PRICE_KIND, RangeButton } from './FilterPanel';

export interface NewHighsPanelParams {
  /** `feed`: every NHOD as its own row, Trade Ideas style. `leaders`: one row per stock, most active first. */
  mode?: 'feed' | 'leaders';
  priceRange?: PriceRange;
  floatRange?: FloatRange;
  minRvol?: number | null;
  minRepeats?: number | null;
  clearedAt?: number;
}

/** A stock with this many NHODs in the streak window is running hard. */
const HOT_REPEATS = 3;
const NEW_ROW_MS = 2_500;
const RVOL_CHOICES = [null, 2, 3, 5];
const REPEAT_CHOICES = [null, 2, 3, 5];
const windowMin = STREAK_WINDOW_MS / 60_000;

const getRowId = (p: GetRowIdParams<NhodRow>) => p.data.id;

function SymbolCell({ data }: CustomCellRendererProps<NhodRow>) {
  if (!data) return null;
  const halted = marketData.rows.get(data.symbol)?.halted;
  return (
    <span className="flex items-center gap-1">
      <span className="font-semibold tracking-wide text-fg">{data.symbol}</span>
      {halted && <span className="rounded bg-warn/15 px-1 text-[9px] font-bold text-warn">HALT</span>}
    </span>
  );
}

function RepeatCell({ data }: CustomCellRendererProps<NhodRow>) {
  if (!data) return null;
  const hot = data.recent >= HOT_REPEATS;
  return (
    <span className={clsx('num inline-flex items-center gap-0.5', hot ? 'font-semibold text-up' : data.recent > 1 ? 'text-fg' : 'text-muted')}>
      {hot && <Flame className="size-3" strokeWidth={2.5} />}
      {data.recent}
    </span>
  );
}

function ChoiceButton({ label, title, value, choices, show, onChange }: {
  label: string;
  title: string;
  value: number | null | undefined;
  choices: (number | null)[];
  show: (n: number) => string;
  onChange: (n: number | null) => void;
}) {
  const on = !!value;
  return (
    <Popover
      trigger={(open) => (
        <button
          type="button"
          title={title}
          className={clsx(
            'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
            on ? 'bg-accent/15 text-accent hover:bg-accent/25' : clsx('text-muted hover:bg-hover hover:text-fg', open && 'bg-hover text-fg'),
          )}
        >
          {on ? show(value) : label}
        </button>
      )}
    >
      {(close) => (
        <div className="w-44">
          <MenuLabel>{title}</MenuLabel>
          {choices.map((c) => (
            <MenuItem key={String(c)} active={(value ?? null) === c} onClick={() => (onChange(c), close())}>
              {c === null ? 'Any' : show(c)}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function NewHighsPanel({ params, api: panelApi }: IDockviewPanelProps<NewHighsPanelParams>) {
  const mode = params.mode ?? 'feed';
  const clearedAt = params.clearedAt ?? 0;
  const gridApi = useRef<GridApi<NhodRow> | null>(null);
  const [alertsVersion, setAlertsVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const nowRef = useRef(now);
  nowRef.current = now;
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const [onSymbolClick] = useState(() => symbolDoubleClick(openQuoteFor));

  useEffect(
    () =>
      marketData.onAlerts((added, reset) => {
        if (reset || added.some((a) => a.type === 'new_high')) setAlertsVersion((v) => v + 1);
      }),
    [],
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const all = useMemo(() => nhodRows(marketData.alerts).filter((r) => r.timestamp > clearedAt), [alertsVersion, clearedAt]);
  const last = useMemo(() => lastNhodBySymbol(all), [all]);
  const lastRef = useRef(last);
  lastRef.current = last;
  const rows = useMemo(() => {
    const list = mode === 'leaders' ? nhodLeaders(all, now) : all;
    const filter = { priceRange: params.priceRange, floatRange: params.floatRange, minRvol: params.minRvol, minRepeats: params.minRepeats };
    return list.filter((r) => passesNhodFilter(r, marketData.rows.get(r.symbol), filter));
  }, [all, mode, now, params.priceRange, params.floatRange, params.minRvol, params.minRepeats]);

  // Live columns (RVOL, float, time since the last NHOD) read the snapshot, not the row.
  useEffect(() => {
    gridApi.current?.refreshCells({ columns: ['rvol', 'float', 'quiet', 'symbol'], force: true });
  }, [now]);

  const update = (patch: Partial<NewHighsPanelParams>) => {
    panelApi.updateParameters(patch);
    requestLayoutSave();
  };

  const columnDefs = useMemo<ColDef<NhodRow>[]>(
    () => [
      { colId: 'time', field: 'timestamp', headerName: 'Time', width: 78, cellClass: 'num text-muted', valueFormatter: (p) => fmtTimeET(p.value) },
      { colId: 'symbol', field: 'symbol', headerName: 'Symbol', width: 84, cellRenderer: SymbolCell },
      { colId: 'price', field: 'price', headerName: 'High', width: 72, type: 'rightAligned', cellClass: 'num', valueFormatter: (p) => fmtPrice(p.value), headerTooltip: 'Price of the new high' },
      {
        colId: 'changePct', field: 'changePct', headerName: 'Chg %', width: 72, type: 'rightAligned', valueFormatter: (p) => fmtPct(p.value, 1),
        cellClassRules: { 'num text-up': (p) => (p.value ?? 0) > 0, 'num text-down': (p) => (p.value ?? 0) < 0, num: () => true },
      },
      { colId: 'nth', field: 'nth', headerName: '# Today', width: 70, type: 'rightAligned', cellClass: 'num text-dim', valueFormatter: (p) => `×${p.value}`, headerTooltip: 'How many new highs of day the stock had made at this alert' },
      { colId: 'recent', field: 'recent', headerName: `${windowMin}m`, width: 58, type: 'rightAligned', cellRenderer: RepeatCell, headerTooltip: `New highs in the last ${windowMin} minutes` },
      {
        colId: 'rvol', headerName: 'RVOL', width: 62, type: 'rightAligned', cellClass: 'num',
        valueGetter: (p) => (p.data ? marketData.rows.get(p.data.symbol)?.rvol ?? null : null), valueFormatter: (p) => fmtMultiple(p.value),
      },
      {
        colId: 'float', headerName: 'Float', width: 64, type: 'rightAligned', cellClass: 'num text-dim',
        valueGetter: (p) => (p.data ? marketData.rows.get(p.data.symbol)?.floatShares ?? null : null), valueFormatter: (p) => fmtCompact(p.value),
      },
      {
        colId: 'quiet', headerName: 'Last NHOD', minWidth: 96, flex: 1,
        headerTooltip: `Time since the stock's latest new high. QUIET after ${QUIET_AFTER_MS / 60_000} min without one, once it has pushed at least twice: the run may be topping.`,
        valueGetter: (p) => {
          const latest = p.data && lastRef.current.get(p.data.symbol);
          return latest ? nowRef.current - latest.timestamp : null;
        },
        cellRenderer: ({ data, value }: CustomCellRendererProps<NhodRow, number | null>) => {
          const latest = data && lastRef.current.get(data.symbol);
          if (!latest || value == null) return null;
          const quiet = isQuiet(latest.nth, latest.timestamp, nowRef.current);
          return (
            <span className={clsx('num', quiet ? 'font-semibold text-warn' : 'text-dim')}>
              {quiet && <span className="mr-1 rounded bg-warn/15 px-1 text-[9px] font-bold">QUIET</span>}
              {fmtAgo(value)}
            </span>
          );
        },
      },
    ],
    [],
  );

  const getRowClass = (p: RowClassParams<NhodRow>) =>
    p.data && mode === 'feed' && Date.now() - p.data.timestamp < NEW_ROW_MS ? 'alert-new' : undefined;

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        <div className="flex rounded-md ring-1 ring-line ring-inset">
          {(
            [
              ['feed', List, 'Feed', 'Every new high as its own row'],
              ['leaders', Trophy, 'Leaders', `One row per stock, most new highs in the last ${windowMin} min first`],
            ] as const
          ).map(([m, Icon, label, title]) => (
            <button
              key={m}
              type="button"
              title={title}
              onClick={() => update({ mode: m })}
              className={clsx('flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', mode === m ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg')}
            >
              <Icon className="size-3" />
              {label}
            </button>
          ))}
        </div>
        <RangeButton
          kind={PRICE_KIND}
          range={params.priceRange}
          label={isActive(params.priceRange) ? rangeLabel(params.priceRange) : 'Price'}
          icon={<DollarSign className="size-3" />}
          onChange={(priceRange) => update({ priceRange })}
        />
        <RangeButton
          kind={FLOAT_KIND}
          range={params.floatRange}
          label={isActive(params.floatRange) ? floatLabel(params.floatRange) : 'Float'}
          icon={<Layers className="size-3" />}
          onChange={(floatRange) => update({ floatRange })}
        />
        <ChoiceButton label="RVOL" title="Minimum relative volume" value={params.minRvol} choices={RVOL_CHOICES} show={(n) => `RVOL ≥ ${n}×`} onChange={(minRvol) => update({ minRvol })} />
        <ChoiceButton
          label="Repeats"
          title={`Minimum new highs in ${windowMin} min`}
          value={params.minRepeats}
          choices={REPEAT_CHOICES}
          show={(n) => `≥ ${n} in ${windowMin}m`}
          onChange={(minRepeats) => update({ minRepeats })}
        />
        <div className="ml-auto flex items-center gap-1">
          <span className="num rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold text-dim">{rows.length}</span>
          <IconButton title="Clear" onClick={() => update({ clearedAt: Date.now() })}>
            <Eraser className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div className="ag-theme-scanner min-h-0 flex-1">
        <AgGridReact<NhodRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: false, suppressHeaderMenuButton: true }}
          getRowId={getRowId}
          getRowClass={getRowClass}
          animateRows={mode === 'feed'}
          onGridReady={(e) => (gridApi.current = e.api)}
          onRowClicked={(e) => {
            if (!e.data) return;
            setSelectedSymbol(e.data.symbol);
            onSymbolClick(e.data.symbol);
          }}
          overlayNoRowsTemplate='<span style="color:#6b7587;font-size:12px">Waiting for new highs of day…</span>'
        />
      </div>
    </div>
  );
}
