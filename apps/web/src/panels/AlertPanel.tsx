import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, RowClassParams } from 'ag-grid-community';
import type { IDockviewPanelProps } from 'dockview';
import { ALERT_TYPES, type Alert, type AlertType } from '@deltascan/shared';
import { Eraser, Volume2, VolumeX } from 'lucide-react';
import clsx from 'clsx';
import { gridTheme } from '../lib/gridTheme';
import { marketData } from '../lib/marketData';
import { ALERT_META } from '../lib/alertMeta';
import { fmtPct, fmtPrice, fmtTimeET } from '../lib/format';
import { requestLayoutSave } from '../lib/layout';
import { useUiStore } from '../store/uiStore';
import { IconButton } from '../components/Popover';

export interface AlertPanelParams {
  types?: AlertType[];
  clearedAt?: number;
}

const MAX_ROWS = 500;
const NEW_ROW_MS = 2_500;

const getRowId = (p: GetRowIdParams<Alert>) => p.data.id;
const getRowClass = (p: RowClassParams<Alert>) =>
  p.data && Date.now() - p.data.timestamp < NEW_ROW_MS ? 'alert-new' : undefined;

function TypeCell({ data }: CustomCellRendererProps<Alert>) {
  if (!data) return null;
  const meta = ALERT_META[data.type];
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold tracking-wide ring-1 ring-inset', meta.badge)}>
      <meta.icon className="size-3" strokeWidth={2.5} />
      {meta.short}
    </span>
  );
}

function SymbolCell({ value }: CustomCellRendererProps<Alert, string>) {
  return <span className="font-semibold tracking-wide text-fg">{value}</span>;
}

export function AlertPanel({ params, api: panelApi }: IDockviewPanelProps<AlertPanelParams>) {
  const types = useMemo(() => new Set<AlertType>(params.types ?? ALERT_TYPES), [params.types]);
  const clearedAt = params.clearedAt ?? 0;
  const gridApi = useRef<GridApi<Alert> | null>(null);
  const rowsRef = useRef<Alert[]>([]);
  const filterRef = useRef({ types, clearedAt });
  filterRef.current = { types, clearedAt };
  const [count, setCount] = useState(0);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const audibleTypes = useUiStore((s) => s.settings.audibleTypes);
  const updateSettings = useUiStore((s) => s.updateSettings);

  const passes = (a: Alert) => filterRef.current.types.has(a.type) && a.timestamp > filterRef.current.clearedAt;

  const resetRows = useCallback(() => {
    rowsRef.current = marketData.alerts.filter(passes).slice(0, MAX_ROWS);
    gridApi.current?.setGridOption('rowData', rowsRef.current);
    setCount(rowsRef.current.length);
  }, []);

  useEffect(() => {
    return marketData.onAlerts((added, reset) => {
      if (reset) return resetRows();
      const api = gridApi.current;
      const fresh = added.filter(passes);
      if (!api || !fresh.length) return;
      rowsRef.current = fresh.concat(rowsRef.current);
      const remove = rowsRef.current.length > MAX_ROWS ? rowsRef.current.splice(MAX_ROWS) : [];
      api.applyTransactionAsync({ add: fresh, addIndex: 0, remove });
      setCount(rowsRef.current.length);
    });
  }, [resetRows]);

  useEffect(resetRows, [types, clearedAt, resetRows]);

  const columnDefs = useMemo<ColDef<Alert>[]>(
    () => [
      { colId: 'time', field: 'timestamp', headerName: 'Time', width: 78, cellClass: 'num text-muted', valueFormatter: (p) => fmtTimeET(p.value) },
      { colId: 'symbol', field: 'symbol', headerName: 'Symbol', width: 72, cellRenderer: SymbolCell },
      { colId: 'type', field: 'type', headerName: 'Alert', width: 82, cellRenderer: TypeCell },
      { colId: 'price', field: 'price', headerName: 'Price', width: 74, type: 'rightAligned', cellClass: 'num', valueFormatter: (p) => fmtPrice(p.value) },
      {
        colId: 'changePct', field: 'changePct', headerName: 'Chg %', width: 74, type: 'rightAligned', valueFormatter: (p) => fmtPct(p.value, 1),
        cellClassRules: { 'num text-up': (p) => (p.value ?? 0) > 0, 'num text-down': (p) => (p.value ?? 0) < 0, num: () => true },
      },
      { colId: 'detail', field: 'detail', headerName: 'Detail', flex: 1, minWidth: 140, cellClass: 'text-dim' },
    ],
    [],
  );

  const onGridReady = (e: GridReadyEvent<Alert>) => {
    gridApi.current = e.api;
    resetRows();
  };

  const toggleType = (t: AlertType) => {
    const next = new Set(types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    panelApi.updateParameters({ types: [...next] });
    requestLayoutSave();
  };

  const toggleAudible = (t: AlertType) =>
    updateSettings({ audibleTypes: audibleTypes.includes(t) ? audibleTypes.filter((x) => x !== t) : [...audibleTypes, t] });

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        {ALERT_TYPES.map((t) => {
          const meta = ALERT_META[t];
          const on = types.has(t);
          const audible = audibleTypes.includes(t);
          return (
            <span
              key={t}
              className={clsx(
                'group inline-flex items-center rounded-md text-[10px] font-semibold tracking-wide ring-1 ring-inset transition-colors',
                on ? meta.badge : 'text-muted ring-line hover:text-dim',
              )}
            >
              <button type="button" onClick={() => toggleType(t)} className="flex items-center gap-1 py-0.5 pr-1 pl-1.5" title={`${on ? 'Hide' : 'Show'} ${meta.label}`}>
                <meta.icon className="size-3" strokeWidth={2.5} />
                {meta.short}
              </button>
              <button
                type="button"
                onClick={() => toggleAudible(t)}
                title={audible ? `Mute ${meta.label}` : `Play sound for ${meta.label}`}
                className={clsx('py-0.5 pr-1.5 pl-0.5 transition-opacity', audible ? 'opacity-90' : 'opacity-30 hover:opacity-70')}
              >
                {audible ? <Volume2 className="size-3" /> : <VolumeX className="size-3" />}
              </button>
            </span>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
          <span className="num rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold text-dim">{count}</span>
          <IconButton
            title="Clear alerts"
            onClick={() => {
              panelApi.updateParameters({ clearedAt: Date.now() });
              requestLayoutSave();
            }}
          >
            <Eraser className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div className="ag-theme-scanner min-h-0 flex-1">
        <AgGridReact<Alert>
          theme={gridTheme}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: false, suppressHeaderMenuButton: true }}
          getRowId={getRowId}
          getRowClass={getRowClass}
          onGridReady={onGridReady}
          onRowClicked={(e) => e.data && setSelectedSymbol(e.data.symbol)}
          asyncTransactionWaitMillis={60}
          overlayNoRowsTemplate='<span style="color:#6b7587;font-size:12px">Waiting for alerts…</span>'
        />
      </div>
    </div>
  );
}
