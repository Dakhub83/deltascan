import { useEffect, useRef, useState } from 'react';
import type { CustomCellRendererProps } from 'ag-grid-react';
import type { SymbolSnapshot } from '@deltascan/shared';
import clsx from 'clsx';
import { fmtCompact, fmtMultiple, fmtPct, fmtPrice } from '../lib/format';
import { useUiStore } from '../store/uiStore';

type Props<V> = CustomCellRendererProps<SymbolSnapshot, V>;

export function SymbolCell({ data }: Props<string>) {
  if (!data) return null;
  const chg = data.changePct ?? 0;
  return (
    <div className="flex w-full items-center gap-2 overflow-hidden" title={data.name ?? data.symbol}>
      <span className={clsx('h-3.5 w-[3px] shrink-0 rounded-full', chg > 0 ? 'bg-up' : chg < 0 ? 'bg-down' : 'bg-muted')} />
      <span className="font-semibold tracking-wide text-fg">{data.symbol}</span>
      {data.halted && (
        <span className="rounded bg-warn/15 px-1 text-[9px] font-bold tracking-wider text-warn ring-1 ring-warn/30 ring-inset" title="Trading halted">
          HALT
        </span>
      )}
    </div>
  );
}

/** Price that flashes green/red when it ticks up/down. */
export function PriceCell({ value }: Props<number | null>) {
  const flashEnabled = useUiStore((s) => s.settings.flashCells);
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (!flashEnabled || before == null || value == null || before === value) return;
    setFlash((f) => ({ dir: value > before ? 'up' : 'down', n: (f?.n ?? 0) + 1 }));
  }, [value, flashEnabled]);

  return (
    <span
      key={flash?.n}
      className={clsx('num -mx-1 w-[calc(100%+0.5rem)] rounded-sm px-1 text-right text-fg', flash && `flash-${flash.dir}`)}
    >
      {fmtPrice(value)}
    </span>
  );
}

export function ChangeCell({ value }: Props<number | null>) {
  if (value == null) return <span className="num w-full text-right text-muted">—</span>;
  const strong = Math.abs(value) >= 10;
  return (
    <span className="flex w-full justify-end">
      <span
        className={clsx(
          'num rounded px-1.5 py-px',
          value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-dim',
          strong && (value > 0 ? 'bg-up/15 font-semibold' : 'bg-down/15 font-semibold'),
        )}
      >
        {fmtPct(value)}
      </span>
    </span>
  );
}

export function RvolCell({ value }: Props<number | null>) {
  if (value == null) return <span className="num w-full text-right text-muted">—</span>;
  // Log scale: 1× ≈ 30%, 10× = full
  const width = Math.min(100, Math.max(4, (Math.log10(Math.max(value, 0.1)) + 0.5) * 66));
  const color = value >= 5 ? 'bg-up' : value >= 2 ? 'bg-warn' : value >= 1 ? 'bg-accent' : 'bg-muted';
  return (
    <div className="flex w-full items-center justify-end gap-2">
      <div className="h-1 w-10 overflow-hidden rounded-full bg-line">
        <div className={clsx('h-full rounded-full', color)} style={{ width: `${width}%` }} />
      </div>
      <span className={clsx('num w-10 text-right', value >= 2 ? 'text-fg' : 'text-dim')}>{fmtMultiple(value)}</span>
    </div>
  );
}

export function FloatCell({ value }: Props<number | null>) {
  const low = value != null && value < 10e6;
  return (
    <span className={clsx('num w-full text-right', low ? 'font-semibold text-warn' : 'text-dim')}>{fmtCompact(value)}</span>
  );
}

export type Tier = 'sub-dollar' | 'low-float' | 'large-cap';

const TIER_META: Record<Tier, { label: string; title: string; badge: string }> = {
  'sub-dollar': { label: 'SUB $1', title: 'Trading under $1', badge: 'bg-violet/12 text-violet ring-violet/25' },
  'low-float': { label: 'LOW FLT', title: 'Float under 20M shares', badge: 'bg-warn/12 text-warn ring-warn/25' },
  'large-cap': { label: 'LARGE', title: 'Market cap over $10B', badge: 'bg-accent/12 text-accent ring-accent/25' },
};

/** Quality-at-a-glance tag for momentum movers; untagged means a mid-cap. */
export function TierCell({ value }: Props<Tier | null>) {
  if (!value) return null;
  const meta = TIER_META[value];
  return (
    <span className={clsx('rounded px-1.5 py-px text-[10px] font-semibold tracking-wide ring-1 ring-inset', meta.badge)} title={meta.title}>
      {meta.label}
    </span>
  );
}

/** Day range: low ── ● last ── high, with a VWAP tick. */
export function RangeCell({ data }: Props<unknown>) {
  if (!data || data.low == null || data.high == null || data.last == null) return null;
  const span = data.high - data.low || 1;
  const pos = ((data.last - data.low) / span) * 100;
  const vwapPos = data.vwap != null ? ((data.vwap - data.low) / span) * 100 : null;
  const above = data.vwap != null && data.last >= data.vwap;
  return (
    <div className="relative h-3 w-full" title={`L ${fmtPrice(data.low)} · H ${fmtPrice(data.high)}`}>
      <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 rounded-full bg-line" />
      <div
        className={clsx('absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full', above ? 'bg-up/50' : 'bg-down/50')}
        style={{ width: `${pos}%` }}
      />
      {vwapPos != null && (
        <div className="absolute top-0 h-3 w-px bg-dim/60" style={{ left: `${Math.min(100, Math.max(0, vwapPos))}%` }} />
      )}
      <div
        className={clsx('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel', above ? 'bg-up' : 'bg-down')}
        style={{ left: `${pos}%` }}
      />
    </div>
  );
}
