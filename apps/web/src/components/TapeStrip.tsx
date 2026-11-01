import { useCallback, useId, useSyncExternalStore, type ReactNode } from 'react';
import type { Bar, SymbolSnapshot } from '@deltascan/shared';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { fmtCompact, fmtPct, fmtPrice } from '../lib/format';
import { readTape, type TapeRead } from '../lib/tape';

const LOW_FLOAT = 10e6;

/** A symbol's 1-minute bars (history + live), refreshed at most once a second. */
function useMinuteBars(symbol: string): Bar[] {
  const subscribe = useCallback((onChange: () => void) => marketData.watchMinuteBars(symbol, onChange), [symbol]);
  return useSyncExternalStore(subscribe, () => marketData.getMinuteBars(symbol));
}

function Column({ title, subtitle, children, className }: { title: string; subtitle?: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex min-w-0 flex-col items-center gap-1 px-2 py-2 text-center', className)}>
      <div className="text-[10px] leading-tight font-semibold tracking-wider text-accent/90 uppercase">
        {title}
        {subtitle && <div className="font-medium tracking-normal text-muted normal-case">{subtitle}</div>}
      </div>
      <div className="flex w-full flex-1 flex-col items-center justify-center">{children}</div>
    </div>
  );
}

function Sparkline({ trend }: { trend: TapeRead['trend'] }) {
  const gradient = useId();
  const { closes, volumes, changePct } = trend;
  if (closes.length < 2) return <div className="text-[11px] text-muted">Waiting for bars…</div>;
  const w = 180;
  const h = 70;
  const priceH = h * 0.72;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (closes.length - 1)) * w;
  const y = (c: number) => 4 + (1 - (c - lo) / span) * (priceH - 8);
  const line = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ');
  const up = (changePct ?? 0) >= 0;
  const color = up ? 'var(--color-up)' : 'var(--color-down)';
  const maxVol = Math.max(...volumes.map((v) => v.value), 1);
  const slot = w / volumes.length;
  return (
    <div className="relative w-full">
      {changePct !== null && (
        <span className={clsx('num absolute top-0 right-0 text-[10px] font-semibold', up ? 'text-up' : 'text-down')}>{fmtPct(changePct, 1)}</span>
      )}
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[70px] w-full" aria-label="Price and volume over the last 60 minutes">
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.35" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {volumes.map((v, i) => {
          const bh = (v.value / maxVol) * (h * 0.3);
          return v.value > 0 ? (
            <rect key={i} x={i * slot + slot * 0.25} y={h - bh} width={slot * 0.5} height={bh} fill={v.up ? 'var(--color-up)' : 'var(--color-down)'} opacity="0.45" />
          ) : null;
        })}
        <polygon points={`0,${priceH} ${line} ${w},${priceH}`} fill={`url(#${gradient})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const SIDE = {
  buyers: { label: 'BUYERS IN CONTROL', text: 'text-up', bar: 'bg-up' },
  sellers: { label: 'SELLERS IN CONTROL', text: 'text-down', bar: 'bg-down' },
  balanced: { label: 'BALANCED', text: 'text-warn', bar: 'bg-warn' },
} as const;
const ARROW = { expanding: '↑', contracting: '↓', steady: '→', up: '↑', down: '↓', flat: '→' } as const;

/**
 * Ticker · Price · 60-minute trend · buyers vs sellers, for the top of the Dilution tracker.
 * Works for any streamed symbol, with or without SEC data.
 */
export function TapeStrip({ row, country, sector }: { row: SymbolSnapshot; country: string | null; sector: string | null }) {
  const bars = useMinuteBars(row.symbol);
  const tape = readTape(bars, row);
  const change = row.changePct;
  const side = tape.control ? SIDE[tape.control.side] : null;

  return (
    <section className="@container overflow-hidden rounded-xl border border-line bg-raised/40">
      <div className="grid grid-cols-2 divide-line @[560px]:grid-cols-[1.1fr_0.9fr_1.4fr_1.6fr] @[560px]:divide-x">
        <Column title="Ticker">
          <span className="text-[26px] leading-none font-bold tracking-wide text-cyan">{row.symbol}</span>
          {sector && <span className="mt-1 text-[11px] leading-tight text-muted">{sector}</span>}
          {country && <span className="mt-0.5 text-[11px] font-semibold text-warn">{country}</span>}
          {row.floatShares != null && (
            <span className={clsx('num mt-0.5 text-[11px]', row.floatShares < LOW_FLOAT ? 'text-down' : 'text-dim')}>Float: {fmtCompact(row.floatShares)}</span>
          )}
        </Column>
        <Column title="Price">
          <span className={clsx('num text-[24px] leading-none font-bold', (change ?? 0) >= 0 ? 'text-up' : 'text-down')}>
            {row.last != null ? `$${fmtPrice(row.last)}` : '—'}
          </span>
          {change != null && <span className={clsx('num mt-1 text-[13px] font-semibold', change >= 0 ? 'text-up' : 'text-down')}>{fmtPct(change)}</span>}
        </Column>
        <Column title="Trend" subtitle="60 min" className="border-t border-line @[560px]:border-t-0">
          <Sparkline trend={tape.trend} />
        </Column>
        <Column title="Control" subtitle="buyers vs sellers" className="border-t border-line @[560px]:border-t-0">
          {tape.control && side ? (
            <>
              <span className={clsx('text-[13px] font-bold tracking-wide', side.text)}>● {side.label}</span>
              <div className="mt-1 flex items-center gap-2">
                <span className={clsx('num text-[12px] font-semibold', side.text)}>{tape.control.score}</span>
                <div className="flex gap-0.5" aria-label={`Buying pressure ${tape.control.score} of 100`}>
                  {Array.from({ length: 10 }, (_, i) => (
                    <span key={i} className={clsx('h-2 w-1.5 rounded-sm', i < Math.round(tape.control!.score / 10) ? side.bar : 'bg-line')} />
                  ))}
                </div>
              </div>
            </>
          ) : (
            <span className="text-[11px] text-muted">Not enough bars yet</span>
          )}
          {(tape.volume || tape.momentum) && (
            <div className="mt-1 text-[11px] text-dim">
              {tape.volume && (
                <span>
                  Vol {tape.volume.toUpperCase()} {ARROW[tape.volume]}
                </span>
              )}
              {tape.volume && tape.momentum && ' · '}
              {tape.momentum && (
                <span>
                  Mom {tape.momentum.toUpperCase()} {ARROW[tape.momentum]}
                </span>
              )}
            </div>
          )}
          {tape.status && (
            <div className={clsx('num mt-1 text-[11px] font-semibold', tape.status.tone === 'up' ? 'text-up' : tape.status.tone === 'down' ? 'text-down' : 'text-warn')}>
              {tape.status.text}
            </div>
          )}
        </Column>
      </div>
    </section>
  );
}
