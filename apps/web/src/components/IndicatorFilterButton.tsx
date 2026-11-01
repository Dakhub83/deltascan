import { useState, type FormEvent } from 'react';
import { Activity, X } from 'lucide-react';
import clsx from 'clsx';
import { MenuLabel, Popover } from './Popover';
import { indicatorLabel, isIndicatorFilterActive, RSI_OVERBOUGHT, RSI_OVERSOLD, type IndicatorFilter } from '../scanners/indicatorFilter';

const CROSS_WINDOWS = [null, 5, 15, 30];
const RVOL_CHOICES = [null, 2, 3, 5];

const parseRsi = (text: string) => {
  const n = Number(text.trim());
  return text.trim() === '' || !Number.isFinite(n) ? null : Math.min(100, Math.max(0, n));
};

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-md px-2 py-0.5 text-[11px] ring-1 ring-inset transition-colors',
        on ? 'bg-accent/15 text-accent ring-accent/40' : 'text-dim ring-line hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function Editor({ value, onChange, close }: { value: IndicatorFilter | undefined; onChange: (f: IndicatorFilter | undefined) => void; close: () => void }) {
  const [rsiMin, setRsiMin] = useState(value?.rsiMin != null ? String(value.rsiMin) : '');
  const [rsiMax, setRsiMax] = useState(value?.rsiMax != null ? String(value.rsiMax) : '');
  const [cross, setCross] = useState<IndicatorFilter['cross']>(value?.cross ?? null);
  const [within, setWithin] = useState<number | null>(value?.crossWithinMin ?? 15);
  const [minRvol, setMinRvol] = useState<number | null>(value?.minRvol ?? null);

  const apply = (e?: FormEvent) => {
    e?.preventDefault();
    const next: IndicatorFilter = { rsiMin: parseRsi(rsiMin), rsiMax: parseRsi(rsiMax), cross, crossWithinMin: cross ? within : null, minRvol };
    onChange(isIndicatorFilterActive(next) ? next : undefined);
    close();
  };
  const rsiInput = (val: string, set: (v: string) => void, label: string) => (
    <input
      value={val}
      onChange={(e) => set(e.target.value)}
      inputMode="decimal"
      placeholder={label}
      aria-label={`RSI ${label.toLowerCase()}`}
      className="num h-6 w-full rounded-md border border-line bg-bg px-2 text-[12px] text-fg outline-none placeholder:text-muted focus:border-accent/60"
    />
  );

  return (
    <form className="w-64" onSubmit={apply}>
      <MenuLabel>RSI (14, 1-min)</MenuLabel>
      <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
        {rsiInput(rsiMin, setRsiMin, 'Min')}
        <span className="text-[11px] text-muted">to</span>
        {rsiInput(rsiMax, setRsiMax, 'Max')}
      </div>
      <div className="flex flex-wrap gap-1 px-2.5 pb-2">
        <Chip on={rsiMin === String(RSI_OVERBOUGHT) && !rsiMax} onClick={() => (setRsiMin(String(RSI_OVERBOUGHT)), setRsiMax(''))}>
          Overbought ≥ {RSI_OVERBOUGHT}
        </Chip>
        <Chip on={rsiMin === '80' && !rsiMax} onClick={() => (setRsiMin('80'), setRsiMax(''))}>
          ≥ 80
        </Chip>
        <Chip on={rsiMax === String(RSI_OVERSOLD) && !rsiMin} onClick={() => (setRsiMax(String(RSI_OVERSOLD)), setRsiMin(''))}>
          Oversold ≤ {RSI_OVERSOLD}
        </Chip>
      </div>

      <MenuLabel>EMA 9 / 20 cross</MenuLabel>
      <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
        <Chip on={!cross} onClick={() => setCross(null)}>Any</Chip>
        <Chip on={cross === 'bear'} onClick={() => setCross('bear')}>▼ Bearish</Chip>
        <Chip on={cross === 'bull'} onClick={() => setCross('bull')}>▲ Bullish</Chip>
      </div>
      {cross && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2">
          <span className="mr-0.5 text-[11px] text-muted">within</span>
          {CROSS_WINDOWS.map((w) => (
            <Chip key={String(w)} on={within === w} onClick={() => setWithin(w)}>
              {w === null ? 'today' : `${w}m`}
            </Chip>
          ))}
        </div>
      )}

      <MenuLabel>Volume spike (RVOL)</MenuLabel>
      <div className="flex flex-wrap gap-1 px-2.5 pb-2">
        {RVOL_CHOICES.map((r) => (
          <Chip key={String(r)} on={minRvol === r} onClick={() => setMinRvol(r)}>
            {r === null ? 'Any' : `≥ ${r}×`}
          </Chip>
        ))}
      </div>

      <p className="px-2.5 pb-2 text-[10px] leading-snug text-muted">Computed on completed 1-minute bars. Stocks with fewer than 20 bars have no indicators yet.</p>
      <div className="flex gap-1.5 border-t border-line px-2.5 pt-2 pb-1">
        <button type="submit" className="flex-1 rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent/90">
          Apply
        </button>
        <button type="button" onClick={() => (onChange(undefined), close())} className="rounded-md px-2 py-1 text-[11px] text-dim hover:bg-hover hover:text-fg">
          Clear
        </button>
      </div>
    </form>
  );
}

/** Toolbar button for a scanner window's RSI / EMA-cross / volume-spike conditions. */
export function IndicatorFilterButton({ value, onChange }: { value: IndicatorFilter | undefined; onChange: (f: IndicatorFilter | undefined) => void }) {
  const on = isIndicatorFilterActive(value);
  return (
    <>
      <Popover
        trigger={(open) => (
          <button
            type="button"
            title="Filter by RSI, EMA cross and volume spike"
            className={clsx(
              'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
              on ? 'bg-accent/15 text-accent hover:bg-accent/25' : clsx('text-muted hover:bg-hover hover:text-fg', open && 'bg-hover text-fg'),
            )}
          >
            <Activity className="size-3" />
            {indicatorLabel(value)}
          </button>
        )}
      >
        {(close) => <Editor value={value} onChange={onChange} close={close} />}
      </Popover>
      {on && (
        <button
          type="button"
          title="Clear the indicator filter"
          aria-label="Clear the indicator filter"
          onClick={() => onChange(undefined)}
          className="-ml-1.5 rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-3" />
        </button>
      )}
    </>
  );
}
