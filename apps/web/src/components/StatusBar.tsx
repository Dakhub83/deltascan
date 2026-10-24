import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { useUiStore } from '../store/uiStore';

function useAge(ts: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  return ts ? Math.max(0, now - ts) : null;
}

export function StatusBar() {
  const socket = useUiStore((s) => s.socket);
  const provider = useUiStore((s) => s.provider);
  const stats = useUiStore((s) => s.stats);
  const lastMessageAt = useUiStore((s) => s.lastMessageAt);
  const age = useAge(lastMessageAt);

  const live = socket === 'open' && provider?.state === 'authenticated';
  const stale = age != null && age > 3_000;
  const [label, dot] =
    socket !== 'open'
      ? [socket === 'connecting' ? 'Connecting to server…' : 'Server offline — retrying', 'bg-down']
      : !live
        ? [`Feed ${provider?.state ?? 'idle'}${provider?.message ? ` · ${provider.message}` : ''}`, 'bg-warn']
        : stale
          ? ['No data', 'bg-warn']
          : ['Live', 'bg-up'];

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-bg px-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className={clsx('size-1.5 rounded-full', dot, live && !stale && 'pulse-dot')} />
        <span className={clsx(live && !stale ? 'text-dim' : 'text-warn')}>{label}</span>
        {provider && <span className="text-muted">· {provider.provider}</span>}
      </span>
      {stats && (
        <>
          <span className="num">{stats.tradesPerSec.toLocaleString()} trades/s</span>
          <span className="num">{stats.quotesPerSec.toLocaleString()} quotes/s</span>
          <span className="num">{stats.symbols} symbols</span>
        </>
      )}
      <span className="num">{marketData.alerts.length} alerts</span>
      <span className="ml-auto num">{age == null ? '' : `updated ${(age / 1000).toFixed(1)}s ago`}</span>
      {provider?.provider === 'mock' && <span className="text-warn/80">Simulated data — not for trading</span>}
    </footer>
  );
}
