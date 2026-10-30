import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ColumnState, GetRowIdParams, GridApi, GridReadyEvent, IRowNode } from 'ag-grid-community';
import type { IDockviewPanelProps } from 'dockview';
import type { SymbolSnapshot } from '@deltascan/shared';
import { Check, ChevronDown, Columns3, DollarSign, Layers, Pause, Play, X } from 'lucide-react';
import clsx from 'clsx';
import { inPriceRange, isActive, parseBound, PRICE_PRESETS, rangeLabel, type PriceRange } from '../scanners/priceRange';
import { FLOAT_PRESETS, floatLabel, inFloatRange, parseFloatBound, type FloatRange } from '../scanners/floatRange';
import { gridTheme } from '../lib/gridTheme';
import { marketData } from '../lib/marketData';
import { openQuoteFor, requestLayoutSave, symbolDoubleClick } from '../lib/layout';
import { useUiStore } from '../store/uiStore';
import { ALL_COLUMN_IDS, COLUMNS, type ColumnId } from '../scanners/columns';
import { PRESETS, PRESETS_BY_ID } from '../scanners/presets';
import { IconButton, MenuItem, MenuLabel, Popover } from '../components/Popover';

export interface FilterPanelParams {
  presetId: string;
  columnState?: ColumnState[];
  /** Applied on top of the scanner's own filter; per window. */
  priceRange?: PriceRange;
  /** Float in shares, applied the same way. */
  floatRange?: FloatRange;
}

const getRowId = (p: GetRowIdParams<SymbolSnapshot>) => p.data.symbol;

interface RangeKind {
  title: string;
  /** Shown inside the inputs: "$" before, "M" after. */
  prefix?: string;
  suffix?: string;
  presets: { label: string; range: PriceRange }[];
  parse: (text: string) => number | null;
  /** A stored bound as input text. */
  show: (n: number) => string;
  anyLabel: string;
  note?: string;
}

const PRICE_KIND: RangeKind = {
  title: 'Price',
  prefix: '$',
  presets: PRICE_PRESETS,
  parse: parseBound,
  show: String,
  anyLabel: 'Any price',
};

const FLOAT_KIND: RangeKind = {
  title: 'Float (shares)',
  suffix: 'M',
  presets: FLOAT_PRESETS,
  parse: parseFloatBound,
  show: (n) => String(+(n / 1e6).toFixed(3)),
  anyLabel: 'Any float',
  note: 'Type millions, or use K (500K). Symbols with an unknown float still show.',
};

function RangeFilter({ kind, range, onChange, close }: { kind: RangeKind; range: PriceRange | undefined; onChange: (r: PriceRange | undefined) => void; close: () => void }) {
  const [min, setMin] = useState(range?.min != null ? kind.show(range.min) : '');
  const [max, setMax] = useState(range?.max != null ? kind.show(range.max) : '');
  const apply = (r: PriceRange | undefined) => {
    onChange(isActive(r) ? r : undefined);
    close();
  };
  const input = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex flex-1 items-center gap-1 rounded-md border border-line bg-bg px-2 focus-within:border-accent/60">
      {kind.prefix && <span className="text-[11px] text-muted">{kind.prefix}</span>}
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        inputMode="decimal"
        placeholder={label}
        aria-label={`${label} ${kind.title.toLowerCase()}`}
        className="num h-6 w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-muted"
      />
      {kind.suffix && <span className="text-[11px] text-muted">{kind.suffix}</span>}
    </label>
  );
  return (
    <form
      className="w-60"
      onSubmit={(e) => {
        e.preventDefault();
        apply({ min: kind.parse(min), max: kind.parse(max) });
      }}
    >
      <MenuLabel>{kind.title}</MenuLabel>
      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        {input(min, setMin, 'Min')}
        <span className="text-[11px] text-muted">to</span>
        {input(max, setMax, 'Max')}
      </div>
      <div className="flex flex-wrap gap-1 px-2.5 pb-2">
        {kind.presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => apply(p.range)}
            className={clsx(
              'rounded-md px-2 py-0.5 text-[11px] ring-1 ring-inset transition-colors',
              range?.min === p.range.min && range?.max === p.range.max ? 'bg-accent/15 text-accent ring-accent/40' : 'text-dim ring-line hover:bg-hover hover:text-fg',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {kind.note && <p className="px-2.5 pb-2 text-[10px] leading-snug text-muted">{kind.note}</p>}
      <div className="flex gap-1.5 border-t border-line px-2.5 pt-2 pb-1">
        <button type="submit" className="flex-1 rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent/90">
          Apply
        </button>
        <button type="button" onClick={() => apply(undefined)} className="rounded-md px-2 py-1 text-[11px] text-dim hover:bg-hover hover:text-fg">
          {kind.anyLabel}
        </button>
      </div>
    </form>
  );
}

/** Toolbar button that opens a range popover; turns blue and shows the range while one is set. */
function RangeButton({
  kind,
  range,
  label,
  icon,
  onChange,
}: {
  kind: RangeKind;
  range: PriceRange | undefined;
  label: string;
  icon: ReactNode;
  onChange: (r: PriceRange | undefined) => void;
}) {
  const on = isActive(range);
  const noun = kind.title.split(' ')[0]!.toLowerCase();
  return (
    <>
      <Popover
        trigger={(open) => (
          <button
            type="button"
            title={`Filter by ${noun}`}
            className={clsx(
              'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
              on ? 'bg-accent/15 text-accent hover:bg-accent/25' : clsx('text-muted hover:bg-hover hover:text-fg', open && 'bg-hover text-fg'),
            )}
          >
            {icon}
            {label}
          </button>
        )}
      >
        {(close) => <RangeFilter kind={kind} range={range} onChange={onChange} close={close} />}
      </Popover>
      {on && (
        <button
          type="button"
          title={`Clear the ${noun} filter`}
          aria-label={`Clear the ${noun} filter`}
          onClick={() => onChange(undefined)}
          className="-ml-1.5 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-3" />
        </button>
      )}
    </>
  );
}

export function FilterPanel({ params, api: panelApi }: IDockviewPanelProps<FilterPanelParams>) {
  const preset = PRESETS_BY_ID.get(params.presetId) ?? PRESETS[0]!;
  const gridApi = useRef<GridApi<SymbolSnapshot> | null>(null);
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const priceRef = useRef(params.priceRange);
  priceRef.current = params.priceRange;
  const floatRef = useRef(params.floatRange);
  floatRef.current = params.floatRange;
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [count, setCount] = useState(0);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => visibleFrom(params.columnState, preset.columns));
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const [onSymbolClick] = useState(() => symbolDoubleClick(openQuoteFor));

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

  useEffect(() => {
    gridApi.current?.onFilterChanged();
  }, [params.priceRange, params.floatRange]);

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

  const setPriceRange = (priceRange: PriceRange | undefined) => {
    panelApi.updateParameters({ priceRange });
    requestLayoutSave();
  };
  const setFloatRange = (floatRange: FloatRange | undefined) => {
    panelApi.updateParameters({ floatRange });
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

        <RangeButton
          kind={PRICE_KIND}
          range={params.priceRange}
          label={isActive(params.priceRange) ? rangeLabel(params.priceRange) : 'Price'}
          icon={<DollarSign className="size-3" />}
          onChange={setPriceRange}
        />
        <RangeButton
          kind={FLOAT_KIND}
          range={params.floatRange}
          label={isActive(params.floatRange) ? floatLabel(params.floatRange) : 'Float'}
          icon={<Layers className="size-3" />}
          onChange={setFloatRange}
        />

        <span className="hidden truncate text-[11px] text-muted @[620px]:inline">{preset.description}</span>

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
          doesExternalFilterPass={(node: IRowNode<SymbolSnapshot>) => !!node.data && inPriceRange(node.data.last, priceRef.current) && inFloatRange(node.data.floatShares, floatRef.current) && presetRef.current.filter(node.data)}
          onModelUpdated={(e) => setCount(e.api.getDisplayedRowCount())}
          rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => {
            if (!e.data) return;
            setSelectedSymbol(e.data.symbol);
            onSymbolClick(e.data.symbol);
          }}
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
