import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi } from 'ag-grid-community';
import type { SymbolSnapshot } from '@deltascan/shared';
import { Plus, X } from 'lucide-react';
import { gridTheme } from '../lib/gridTheme';
import { marketData } from '../lib/marketData';
import type { IDockviewPanelProps } from 'dockview';
import { symbolClicks } from '../lib/layout';
import { COLUMNS, type ColumnId } from '../scanners/columns';
import { useUiStore } from '../store/uiStore';
import { useWatchlistStore } from '../store/watchlistStore';

/** A watched symbol the feed hasn't delivered yet still gets a row. */
type Row = SymbolSnapshot | { symbol: string; pending: true };

const SHOWN: ColumnId[] = ['symbol', 'last', 'changePct', 'volume', 'rvol', 'fadeStage', 'rsi14', 'emaCross', 'vwapDistPct'];
const getRowId = (p: GetRowIdParams<Row>) => p.data.symbol;
const rowFor = (symbol: string): Row => marketData.rows.get(symbol) ?? { symbol, pending: true };

function RemoveCell({ data }: CustomCellRendererProps<Row>) {
  const remove = useWatchlistStore((s) => s.remove);
  if (!data) return null;
  return (
    <button
      type="button"
      title={`Remove ${data.symbol}`}
      aria-label={`Remove ${data.symbol} from the watchlist`}
      onClick={(e) => (e.stopPropagation(), void remove(data.symbol))}
      className="grid size-5 place-items-center rounded text-muted hover:bg-hover hover:text-down"
    >
      <X className="size-3" />
    </button>
  );
}

export function WatchlistPanel({ api: panelApi }: IDockviewPanelProps) {
  const symbols = useWatchlistStore((s) => s.symbols);
  const loaded = useWatchlistStore((s) => s.loaded);
  const error = useWatchlistStore((s) => s.error);
  const add = useWatchlistStore((s) => s.add);
  const [input, setInput] = useState('');
  const gridApi = useRef<GridApi<Row> | null>(null);
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const [onSymbolClick] = useState(() => symbolClicks(panelApi.id));

  // Live data for the watched symbols only.
  useEffect(
    () =>
      marketData.onRows((changed, reset) => {
        const api = gridApi.current;
        if (!api) return;
        if (reset) return api.setGridOption('rowData', symbolsRef.current.map(rowFor));
        const watched = new Set(symbolsRef.current);
        const update = changed.filter((r) => watched.has(r.symbol));
        if (update.length) api.applyTransactionAsync({ update });
      }),
    [],
  );
  useEffect(() => {
    gridApi.current?.setGridOption('rowData', symbols.map(rowFor));
  }, [symbols]);

  const columnDefs = useMemo<ColDef<Row>[]>(
    () => [
      ...SHOWN.map((id) => COLUMNS[id] as ColDef<Row>),
      { colId: 'remove', headerName: '', width: 40, sortable: false, resizable: false, cellRenderer: RemoveCell, pinned: 'right' },
    ],
    [],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const symbol = input.trim().toUpperCase();
    if (symbol && (await add(symbol))) setInput('');
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <form onSubmit={submit} className="flex min-h-8 shrink-0 items-center gap-1.5 border-b border-line px-2 py-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add ticker…"
          aria-label="Ticker to add"
          maxLength={10}
          className="num h-6 w-32 rounded-md border border-line bg-bg px-2 text-[12px] uppercase text-fg outline-none placeholder:normal-case placeholder:text-muted focus:border-accent/60"
        />
        <button type="submit" title="Add to watchlist" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted hover:bg-hover hover:text-fg">
          <Plus className="size-3" />
          Add
        </button>
        {error && <span className="truncate text-[11px] text-down">{error}</span>}
        <span className="num ml-auto rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold text-dim">{symbols.length}</span>
      </form>
      <div className="ag-theme-scanner min-h-0 flex-1">
        <AgGridReact<Row>
          theme={gridTheme}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, suppressHeaderMenuButton: true }}
          getRowId={getRowId}
          onGridReady={(e) => {
            gridApi.current = e.api;
            e.api.setGridOption('rowData', symbolsRef.current.map(rowFor));
          }}
          onRowClicked={(e) => {
            if (!e.data) return;
            setSelectedSymbol(e.data.symbol);
            onSymbolClick(e.data.symbol);
          }}
          asyncTransactionWaitMillis={60}
          overlayNoRowsTemplate={`<span style="color:#7d8799;font-size:12px">${loaded ? 'Add a ticker above to watch it here.' : 'Loading…'}</span>`}
        />
      </div>
    </div>
  );
}
