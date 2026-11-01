import { useEffect, useRef, useState, type Ref } from 'react';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { fmtPct, fmtPrice, signClass } from '../lib/format';
import { openQuoteFor } from '../lib/layout';
import { pickTapeSymbols, TAPE_INDEXES } from '../lib/tickerTape';
import { useUiStore } from '../store/uiStore';

const PX_PER_SECOND = 45;
/** Prices refresh every second; who's on the tape only every few, so it doesn't reshuffle while you read it. */
const RERANK_MS = 10_000;

function useTapeSymbols(): string[] {
  const [symbols, setSymbols] = useState<string[]>(() => pickTapeSymbols(marketData.rows.values()));
  const [, setTick] = useState(0);
  useEffect(() => {
    const prices = setInterval(() => setTick((t) => t + 1), 1_000);
    const rerank = setInterval(() => setSymbols(pickTapeSymbols(marketData.rows.values())), RERANK_MS);
    // The first snapshot may arrive after mount; don't wait a full rerank for it.
    const off = marketData.onRows((_, reset) => reset && setSymbols(pickTapeSymbols(marketData.rows.values())));
    return () => {
      clearInterval(prices);
      clearInterval(rerank);
      off();
    };
  }, []);
  return symbols;
}

function Item({ symbol }: { symbol: string }) {
  const setSelected = useUiStore((s) => s.setSelectedSymbol);
  const r = marketData.rows.get(symbol);
  if (!r) return null;
  const index = TAPE_INDEXES.includes(symbol);
  return (
    <button
      type="button"
      onClick={() => setSelected(symbol)}
      onDoubleClick={() => openQuoteFor(symbol)}
      title={`${r.name ?? symbol}: click to select, double-click for the quote card`}
      className="flex shrink-0 items-baseline gap-1.5 rounded px-2 py-0.5 hover:bg-hover"
    >
      {!index && r.changePct != null && <span className={clsx('text-[9px]', signClass(r.changePct))}>{r.changePct >= 0 ? '▲' : '▼'}</span>}
      <span className={clsx('text-[11px] font-semibold', index ? 'text-dim' : 'text-fg')}>{symbol}</span>
      <span className="num text-[11px] text-dim">{fmtPrice(r.last)}</span>
      <span className={clsx('num text-[11px] font-medium', signClass(r.changePct))}>{fmtPct(r.changePct, index ? 2 : 1)}</span>
      {r.halted && <span className="rounded bg-warn/15 px-1 text-[9px] font-bold text-warn">HALT</span>}
    </button>
  );
}

/** A scrolling strip of index ETFs and the day's top movers. Hover pauses it. */
export function TickerTape() {
  const symbols = useTapeSymbols();
  const trackRef = useRef<HTMLDivElement>(null);
  const firstCopyRef = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (reducedMotion) return;
    let offset = 0;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const width = firstCopyRef.current?.offsetWidth ?? 0;
      if (!paused.current && width > 0) {
        offset = (offset + ((now - last) / 1000) * PX_PER_SECOND) % width;
        trackRef.current!.style.transform = `translateX(${-offset}px)`;
      }
      last = now;
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion]);

  if (!symbols.length) return null;
  const copy = (key: string, ref?: Ref<HTMLDivElement>) => (
    <div key={key} ref={ref} className="flex shrink-0 items-center gap-1 pr-6" aria-hidden={key === 'b' || undefined}>
      {symbols.map((s) => (
        <Item key={s} symbol={s} />
      ))}
    </div>
  );

  return (
    <div
      className={clsx('relative h-7 shrink-0 border-b border-line bg-panel', reducedMotion ? 'overflow-x-auto' : 'overflow-hidden')}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      aria-label="Market ticker"
    >
      <div ref={trackRef} className="flex h-full w-max items-center will-change-transform">
        {copy('a', firstCopyRef)}
        {!reducedMotion && copy('b')}
      </div>
      {!reducedMotion && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-panel to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-panel to-transparent" />
        </>
      )}
    </div>
  );
}
