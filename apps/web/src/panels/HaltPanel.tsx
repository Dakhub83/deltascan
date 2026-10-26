import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, RowClassParams } from 'ag-grid-community';
import type { HaltEvent, HaltState } from '@deltascan/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import clsx from 'clsx';
import { gridTheme } from '../lib/gridTheme';
import { marketData } from '../lib/marketData';
import { fmtPct, fmtPrice, fmtTimeET } from '../lib/format';
import { openQuoteFor, symbolDoubleClick } from '../lib/layout';
import { useUiStore } from '../store/uiStore';

const NEW_ROW_MS = 2_500;

const STATE_META: Record<HaltState, { label: string; badge: string }> = {
  halted: { label: 'HALTED', badge: 'bg-warn/12 text-warn ring-warn/25' },
  quoting: { label: 'QUOTING', badge: 'bg-cyan/12 text-cyan ring-cyan/25' },
  resumed: { label: 'RESUMED', badge: 'bg-up/12 text-up ring-up/25' },
};

/** Active halts first, then most recent. */
const byActivityThenTime = (a: HaltEvent, b: HaltEvent) =>
  Number(a.state === 'resumed') - Number(b.state === 'resumed') || b.haltedAt - a.haltedAt;

const getRowId = (p: GetRowIdParams<HaltEvent>) => p.data.id;
const getRowClass = (p: RowClassParams<HaltEvent>) =>
  p.data && Date.now() - p.data.haltedAt < NEW_ROW_MS ? 'alert-new' : undefined;

function StateCell({ data }: CustomCellRendererProps<HaltEvent>) {
  if (!data) return null;
  const meta = STATE_META[data.state];
  return (
    <span className={clsx('inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold tracking-wide ring-1 ring-inset', meta.badge)}>
      {meta.label}
    </span>
  );
}

function SymbolCell({ data }: CustomCellRendererProps<HaltEvent>) {
  if (!data) return null;
  const Arrow = data.direction === 'up' ? ArrowUp : data.direction === 'down' ? ArrowDown : null;
  return (
    <span className="inline-flex items-center gap-1 font-semibold tracking-wide text-fg">
      {data.symbol}
      {Arrow && <Arrow className={clsx('size-3', data.direction === 'up' ? 'text-up' : 'text-down')} strokeWidth={2.5} />}
    </span>
  );
}

function ReasonCell({ data }: CustomCellRendererProps<HaltEvent>) {
  if (!data) return null;
  return (
    <span className="truncate text-dim" title={`${data.reasonCode}: ${data.reason}`}>
      <span className="num mr-1.5 text-muted">{data.reasonCode}</span>
      {data.reason}
    </span>
  );
}

/** Countdown while halted, the reopen time once resumed. Refreshed every second by the panel. */
function ResumeCell({ data }: CustomCellRendererProps<HaltEvent>) {
  if (!data) return null;
  if (data.resumedAt !== null) return <span className="num text-muted">{fmtTimeET(data.resumedAt)}</span>;
  if (data.expectedResumeAt === null) return <span className="text-muted">Pending</span>;
  const left = Math.max(0, Math.round((data.expectedResumeAt - Date.now()) / 1000));
  return (
    <span className={clsx('num font-semibold', left <= 30 ? 'text-cyan' : 'text-warn')}>
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  );
}

const signRules = {
  'num text-up': (p: { value?: number | null }) => (p.value ?? 0) > 0,
  'num text-down': (p: { value?: number | null }) => (p.value ?? 0) < 0,
  num: () => true,
};

export function HaltPanel() {
  const gridApi = useRef<GridApi<HaltEvent> | null>(null);
  const [counts, setCounts] = useState({ active: 0, total: 0 });
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const [onSymbolClick] = useState(() => symbolDoubleClick(openQuoteFor));

  const resetRows = useCallback(() => {
    const rows = [...marketData.halts.values()].sort(byActivityThenTime);
    gridApi.current?.setGridOption('rowData', rows);
    setCounts({ active: rows.filter((h) => h.state !== 'resumed').length, total: rows.length });
  }, []);

  // Halts are rare and re-sorting moves rows between the active and resumed groups,
  // so a full reset is simpler than transactions and still cheap.
  useEffect(() => marketData.onHalts(resetRows), [resetRows]);

  useEffect(() => {
    const timer = setInterval(() => gridApi.current?.refreshCells({ columns: ['resume'], force: true }), 1_000);
    return () => clearInterval(timer);
  }, []);

  const columnDefs = useMemo<ColDef<HaltEvent>[]>(
    () => [
      { colId: 'time', field: 'haltedAt', headerName: 'Halted', width: 78, cellClass: 'num text-muted', valueFormatter: (p) => fmtTimeET(p.value) },
      { colId: 'symbol', field: 'symbol', headerName: 'Symbol', width: 84, cellRenderer: SymbolCell },
      { colId: 'state', field: 'state', headerName: 'Status', width: 88, cellRenderer: StateCell },
      { colId: 'resume', headerName: 'Resumes', width: 80, cellRenderer: ResumeCell },
      { colId: 'haltPrice', field: 'haltPrice', headerName: 'Halt Px', width: 78, type: 'rightAligned', cellClass: 'num', valueFormatter: (p) => fmtPrice(p.value) },
      { colId: 'haltChangePct', field: 'haltChangePct', headerName: 'Chg %', width: 76, type: 'rightAligned', valueFormatter: (p) => fmtPct(p.value, 1), cellClassRules: signRules },
      { colId: 'resumePrice', field: 'resumePrice', headerName: 'Open Px', width: 78, type: 'rightAligned', cellClass: 'num', valueFormatter: (p) => fmtPrice(p.value) },
      { colId: 'resumeGapPct', field: 'resumeGapPct', headerName: 'Gap %', width: 72, type: 'rightAligned', valueFormatter: (p) => fmtPct(p.value, 1), cellClassRules: signRules },
      { colId: 'reason', field: 'reason', headerName: 'Reason', flex: 1, minWidth: 160, cellRenderer: ReasonCell },
    ],
    [],
  );

  const onGridReady = (e: GridReadyEvent<HaltEvent>) => {
    gridApi.current = e.api;
    resetRows();
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-[11px]">
        <span className="text-muted">Today</span>
        <div className="ml-auto flex items-center gap-1">
          <span
            className={clsx('num rounded px-1.5 py-0.5 text-[10px] font-semibold', counts.active ? 'bg-warn/12 text-warn' : 'bg-line text-muted')}
            title="Currently halted"
          >
            {counts.active} halted
          </span>
          <span className="num rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold text-dim" title="Halts today">
            {counts.total}
          </span>
        </div>
      </div>
      <div className="ag-theme-scanner min-h-0 flex-1">
        <AgGridReact<HaltEvent>
          theme={gridTheme}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: false, suppressHeaderMenuButton: true }}
          getRowId={getRowId}
          getRowClass={getRowClass}
          onGridReady={onGridReady}
          onRowClicked={(e) => {
            if (!e.data) return;
            setSelectedSymbol(e.data.symbol);
            onSymbolClick(e.data.symbol);
          }}
          overlayNoRowsTemplate='<span style="color:#6b7587;font-size:12px">No halts today</span>'
        />
      </div>
    </div>
  );
}
