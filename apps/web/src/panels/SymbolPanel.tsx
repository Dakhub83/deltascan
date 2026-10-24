import { useEffect, useMemo, useState } from 'react';
import type { Alert, SymbolSnapshot } from '@scanner/shared';
import { Crosshair } from 'lucide-react';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { ALERT_META } from '../lib/alertMeta';
import { fmtCompact, fmtMultiple, fmtPct, fmtPrice, fmtTimeET, signClass } from '../lib/format';
import { useUiStore } from '../store/uiStore';
import { derived } from '../scanners/columns';

function useSymbol(symbol: string | null) {
  const [snap, setSnap] = useState<SymbolSnapshot | null>(() => (symbol ? marketData.rows.get(symbol) ?? null : null));
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    if (!symbol) return;
    setSnap(marketData.rows.get(symbol) ?? null);
    const pick = () => setAlerts(marketData.alerts.filter((a) => a.symbol === symbol).slice(0, 12));
    pick();
    const offRows = marketData.onRows((changed, reset) => {
      if (reset || changed.some((s) => s.symbol === symbol)) setSnap(marketData.rows.get(symbol) ?? null);
    });
    const offAlerts = marketData.onAlerts((added, reset) => {
      if (reset || added.some((a) => a.symbol === symbol)) pick();
    });
    return () => {
      offRows();
      offAlerts();
    };
  }, [symbol]);

  return { snap, alerts };
}

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const step = 100 / (points.length - 1);
    const coords = points.map((p, i) => `${(i * step).toFixed(2)},${(36 - ((p - min) / span) * 32 - 2).toFixed(2)}`);
    return { line: `M${coords.join('L')}`, area: `M0,36L${coords.join('L')}L100,36Z` };
  }, [points]);

  if (!path) {
    return <div className="grid h-16 place-items-center text-[11px] text-muted">Collecting intraday ticks…</div>;
  }
  const color = up ? 'var(--color-up)' : 'var(--color-down)';
  return (
    <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Intraday price, last 10 minutes">
      <defs>
        <linearGradient id={`spark-${up}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill={`url(#spark-${up})`} />
      <path d={path.line} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RangeGauge({ s }: { s: SymbolSnapshot }) {
  if (s.low == null || s.high == null || s.last == null) return null;
  const span = s.high - s.low || 1;
  const at = (v: number | null) => (v == null ? null : Math.min(100, Math.max(0, ((v - s.low!) / span) * 100)));
  const last = at(s.last)!;
  const open = at(s.open);
  const vwap = at(s.vwap);
  // Keep edge labels inside the panel.
  const anchor = (pos: number) => (pos < 10 ? 'translate-x-0' : pos > 90 ? '-translate-x-full' : '-translate-x-1/2');
  return (
    <div className="mt-3">
      <div className="relative h-4">
        {vwap != null && (
          <span className={clsx('absolute bottom-0 text-[9px] font-semibold text-cyan', anchor(vwap))} style={{ left: `${vwap}%` }}>
            VWAP {fmtPrice(s.vwap)}
          </span>
        )}
      </div>
      <div className="relative my-1 h-1.5 rounded-full bg-line">
        <div className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-down/60 via-warn/50 to-up/70" style={{ width: `${last}%` }} />
        {vwap != null && <span className="absolute -top-1 h-3.5 w-px bg-cyan" style={{ left: `${vwap}%` }} />}
        {open != null && <span className="absolute -top-1 h-3.5 w-px bg-dim" style={{ left: `${open}%` }} />}
        <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg ring-3 ring-panel" style={{ left: `${last}%` }} />
      </div>
      <div className="relative h-4">
        {open != null && (
          <span className={clsx('absolute top-0 text-[9px] font-semibold text-dim', anchor(open))} style={{ left: `${open}%` }}>
            OPEN
          </span>
        )}
      </div>
      <div className="num flex justify-between text-[10px] text-muted">
        <span>L {fmtPrice(s.low)}</span>
        <span>H {fmtPrice(s.high)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/60 py-1.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={clsx('num text-[12px] text-fg', className)}>{value}</span>
    </div>
  );
}

export function SymbolPanel() {
  const symbol = useUiStore((s) => s.selectedSymbol);
  const { snap, alerts } = useSymbol(symbol);
  const [, forceTick] = useState(0);

  // Sparkline history is sampled once a second.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!symbol || !snap) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-panel text-center text-muted">
        <Crosshair className="size-6 text-line-strong" />
        <div className="text-[12px]">Select a symbol</div>
        <div className="max-w-56 text-[11px]">Click any row in a scanner or alert window, or type a ticker in the top bar.</div>
      </div>
    );
  }

  const chg = snap.changePct;
  const chgAbs = snap.last != null && snap.prevClose != null ? snap.last - snap.prevClose : null;
  const history = marketData.history.get(symbol) ?? [];
  const spread = derived.spreadPct(snap);

  return (
    <div className="h-full overflow-y-auto bg-panel px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[20px] leading-none font-bold tracking-wide">{snap.symbol}</span>
            {snap.sector && (
              <span className="rounded bg-line px-1.5 py-0.5 text-[10px] font-medium text-dim">{snap.sector}</span>
            )}
          </div>
          <div className="mt-1 truncate text-[11px] text-muted">{snap.name ?? '—'}</div>
        </div>
        <div className="text-right">
          <div className="num text-[22px] leading-none font-semibold">{fmtPrice(snap.last)}</div>
          <div className={clsx('num mt-1 text-[12px] font-medium', signClass(chg))}>
            {chgAbs != null ? `${chgAbs > 0 ? '+' : ''}${chgAbs.toFixed(2)}` : '—'} ({fmtPct(chg)})
          </div>
        </div>
      </div>

      <div className="num mt-3 grid grid-cols-2 gap-1.5 text-[11px]">
        <div className="flex items-center justify-between rounded-md bg-up/8 px-2 py-1 ring-1 ring-up/15 ring-inset">
          <span className="text-muted">BID</span>
          <span className="text-up">
            {fmtPrice(snap.bid)} <span className="text-muted">× {fmtCompact(snap.bidSize, 0)}</span>
          </span>
        </div>
        <div className="flex items-center justify-between rounded-md bg-down/8 px-2 py-1 ring-1 ring-down/15 ring-inset">
          <span className="text-muted">ASK</span>
          <span className="text-down">
            {fmtPrice(snap.ask)} <span className="text-muted">× {fmtCompact(snap.askSize, 0)}</span>
          </span>
        </div>
      </div>

      <div className="mt-3 rounded-md bg-bg/60 px-1 pt-1 ring-1 ring-line ring-inset">
        <Sparkline points={history} up={(chg ?? 0) >= 0} />
      </div>

      <RangeGauge s={snap} />

      <div className="mt-2 grid grid-cols-2 gap-x-4">
        <Stat label="Open" value={fmtPrice(snap.open)} />
        <Stat label="Prev Close" value={fmtPrice(snap.prevClose)} />
        <Stat label="VWAP" value={fmtPrice(snap.vwap)} />
        <Stat label="Gap" value={fmtPct(snap.gapPct)} className={signClass(snap.gapPct)} />
        <Stat label="Volume" value={fmtCompact(snap.volume, 2)} />
        <Stat label="Avg Volume" value={fmtCompact(snap.avgVolume)} />
        <Stat label="RVOL" value={fmtMultiple(snap.rvol)} className={(snap.rvol ?? 0) >= 2 ? 'text-warn' : undefined} />
        <Stat label="Spread" value={spread == null ? '—' : `${spread.toFixed(2)}%`} />
        <Stat label="Float" value={fmtCompact(snap.floatShares)} className={(snap.floatShares ?? Infinity) < 10e6 ? 'text-warn' : undefined} />
        <Stat label="Market Cap" value={fmtCompact(snap.marketCap)} />
        <Stat label="Short Interest" value={snap.shortInterestPct == null ? '—' : `${snap.shortInterestPct.toFixed(1)}%`} />
        <Stat label="Trades" value={fmtCompact(snap.tradeCount)} />
      </div>

      <div className="mt-4 mb-1.5 text-[10px] font-semibold tracking-wider text-muted uppercase">Recent alerts</div>
      {alerts.length === 0 ? (
        <div className="text-[11px] text-muted">None yet</div>
      ) : (
        <ul className="space-y-0.5">
          {alerts.map((a) => {
            const meta = ALERT_META[a.type];
            return (
              <li key={a.id} className="flex items-center gap-2 rounded px-1 py-1 text-[11px] hover:bg-hover">
                <span className="num w-14 shrink-0 text-muted">{fmtTimeET(a.timestamp)}</span>
                <meta.icon className={clsx('size-3 shrink-0', meta.text)} strokeWidth={2.5} />
                <span className={clsx('w-12 shrink-0 font-semibold', meta.text)}>{meta.short}</span>
                <span className="truncate text-dim">{a.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
