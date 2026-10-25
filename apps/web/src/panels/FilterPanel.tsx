import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ColumnState, GetRowIdParams, GridApi, GridReadyEvent, IRowNode } from 'ag-grid-community';
import type { IDockviewPanelProps } from 'dockview';
import type { SymbolSnapshot } from '@deltascan/shared';
import { Check, ChevronDown, Columns3, Pause, Play } from 'lucide-react';
import clsx from 'clsx';
import { gridTheme } from '../lib/gridTheme';
import { marketData } from '../lib/marketData';
import { requestLayoutSave } from '../lib/layout';
import { useUiStore } from '../store/uiStore';
import { ALL_COLUMN_IDS, COLUMNS, type ColumnId } from '../scanners/columns';
import { PRESETS, PRESETS_BY_ID } from '../scanners/presets';
import { IconButton, MenuItem, MenuLabel, Popover } from '../components/Popover';

export interface FilterPanelParams {
  presetId: string;
  columnState?: ColumnState[];
}

const getRowId = (p: GetRowIdParams<SymbolSnapshot>) => p.data.symbol;

export function FilterPanel({ params, api: panelApi }: IDockviewPanelProps<FilterPanelParams>) {
  const preset = PRESETS_BY_ID.get(params.presetId) ?? PRESETS[0]!;
  const gridApi = useRef<GridApi<SymbolSnapshot> | null>(null);
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [count, setCount] = useState(0);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => visibleFrom(params.columnState, preset.columns));
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);

  const columnDefs = useMemo<ColDef<SymbolSnapshot>[]>(() => {
    const ordered = [...preset.columns, ...ALL_COLUMN_IDS.filter((id) => !preset.columns.includes(id))];
    return ordered.map((id) => ({
      ...COLUMNS[id],
      hide: !preset.columns.includes(id),
      sort: id === preset.sort.colId ? preset.sort.sort : null,
    }));
  }, [preset]);

  const defaultColDef = useMemo<ColDef>(() => ({ resizable: true, sortable: true, suppressMovable: false, suppressHeaderMenuButton: true }), []);

  // ── Live data: coalesced batches → one async transaction ──
  useEffect(() => {
    return marketData.onRows((changed, reset) => {
      const api = gridApi.current;
      if (!api) return;
      if (reset) {
        api.setGridOption('rowData', [...marketData.rows.values()]);
        return;
      }
      if (pausedRef.current) return;
      const update: SymbolSnapshot[] = [];
      const add: SymbolSnapshot[] = [];
      for (const row of changed) (api.getRowNode(row.symbol) ? update : add).push(row);
      api.applyTransactionAsync({ update, add });
    });
  }, []);

  // Preset switched from the toolbar: re-filter and re-sort.
  useEffect(() => {
    const api = gridApi.current;
    if (!api) return;
    api.onFilterChanged();
    setVisibleCols(new Set(preset.columns));
  }, [preset]);

  // Keep row selection linked to the global selected symbol.
  useEffect(() => {
    const api = gridApi.current;
    if (!api) return;
    const node = selectedSymbol ? api.getRowNode(selectedSymbol) : undefined;
    if (node) node.setSelected(true, true);
    else api.deselectAll();
  }, [selectedSymbol]);

  const onGridReady = useCallback(
    (e: GridReadyEvent<SymbolSnapshot>) => {
      gridApi.current = e.api;
      e.api.setGridOption('rowData', [...marketData.rows.values()]);
      if (params.columnState) e.api.applyColumnState({ state: params.columnState, applyOrder: true });
    },
    // Mount only: saved column state is applied once.
    [],
  );

  const persistColumns = useCallback(() => {
    const api = gridApi.current;
    if (!api) return;
    panelApi.updateParameters({ columnState: api.getColumnState() });
    requestLayoutSave();
  }, [panelApi]);

  const togglePaused = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) gridApi.current?.setGridOption('rowData', [...marketData.rows.values()]);
  };

  const switchPreset = (id: string) => {
    const next = PRESETS_BY_ID.get(id);
    if (!next) return;
    panelApi.updateParameters({ presetId: id, columnState: undefined });
    panelApi.setTitle(next.title);
    requestLayoutSave();
  };

  const toggleColumn = (id: ColumnId) => {
    const api = gridApi.current;
    if (!api || id === 'symbol') return;
    const show = !visibleCols.has(id);
    api.setColumnsVisible([id], show);
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (show) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const Icon = preset.icon;

  return (
    <div className="@container flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <Popover
          trigger={(open) => (
            <button
              type="button"
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-hover',
                open ? 'bg-hover text-fg' : 'text-fg',
              )}
            >
              <Icon className="size-3.5 text-accent" />
              {preset.title}
              <ChevronDown className="size-3 text-muted" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuLabel>Scanner</MenuLabel>
              {PRESETS.map((p) => (
                <MenuItem
                  key={p.id}
                  active={p.id === preset.id}
                  onClick={() => {
                    switchPreset(p.id);
                    close();
                  }}
                >
                  <p.icon className="size-3.5 shrink-0 text-accent" />
                  <span className="flex flex-col">
                    <span>{p.title}</span>
                    <span className="text-[10px] text-muted">{p.description}</span>
                  </span>
                </MenuItem>
              ))}
            </>
          )}
        </Popover>

        <span className="hidden truncate text-[11px] text-muted @[520px]:inline">{preset.description}</span>

        <div className="ml-auto flex items-center gap-1">
          <span
            className={clsx(
              'num mr-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
              count ? 'bg-accent/12 text-accent' : 'bg-line text-muted',
            )}
            title="Matching symbols"
          >
            {count}
          </span>
          {paused && <span className="mr-1 text-[10px] font-semibold tracking-wider text-warn uppercase">Paused</span>}
          <IconButton title={paused ? 'Resume updates' : 'Pause updates'} onClick={togglePaused} active={paused}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </IconButton>
          <Popover
            align="right"
            trigger={() => (
              <IconButton title="Columns">
                <Columns3 className="size-3.5" />
              </IconButton>
            )}
          >
            {() => (
              <div>
                <MenuLabel>Columns</MenuLabel>
                {ALL_COLUMN_IDS.filter((id) => id !== 'symbol').map((id) => (
                  <MenuItem key={id} onClick={() => toggleColumn(id)} active={visibleCols.has(id)}>
                    <span
                      className={clsx(
                        'grid size-3.5 place-items-center rounded border',
                        visibleCols.has(id) ? 'border-accent bg-accent text-white' : 'border-line-strong',
                      )}
                    >
                      {visibleCols.has(id) && <Check className="size-2.5" strokeWidth={3} />}
                    </span>
                    {COLUMNS[id].headerName}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
        </div>
      </div>

      <div className="ag-theme-scanner min-h-0 flex-1">
        <AgGridReact<SymbolSnapshot>
          theme={gridTheme}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          onGridReady={onGridReady}
          isExternalFilterPresent={() => true}
          doesExternalFilterPass={(node: IRowNode<SymbolSnapshot>) => !!node.data && presetRef.current.filter(node.data)}
          onModelUpdated={(e) => setCount(e.api.getDisplayedRowCount())}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => e.data && setSelectedSymbol(e.data.symbol)}
          onCellFocused={(e) => {
            if (e.rowIndex == null || e.rowPinned) return;
            const sym = e.api.getDisplayedRowAtIndex(e.rowIndex)?.data?.symbol;
            if (sym && sym !== useUiStore.getState().selectedSymbol) setSelectedSymbol(sym);
          }}
          onColumnMoved={(e) => e.finished && persistColumns()}
          onColumnResized={(e) => e.finished && persistColumns()}
          onSortChanged={persistColumns}
          onColumnVisible={persistColumns}
          asyncTransactionWaitMillis={50}
          suppressCellFocus={false}
          animateRows
          suppressDragLeaveHidesColumns
          overlayNoRowsTemplate={`<span style="color:#6b7587;font-size:12px;padding:0 16px;text-align:center">${
            preset.emptyText ?? 'No symbols match this scan right now'
          }</span>`}
        />
      </div>
    </div>
  );
}

function visibleFrom(state: ColumnState[] | undefined, fallback: string[]): Set<string> {
  if (!state) return new Set(fallback);
  return new Set(state.filter((c) => !c.hide).map((c) => c.colId));
}
