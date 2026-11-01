import { TopBar } from './components/TopBar';
import { StatusBar } from './components/StatusBar';
import { TickerTape } from './components/TickerTape';
import { Workspace } from './components/Workspace';
import clsx from 'clsx';
import { useUiStore } from './store/uiStore';

function Notice() {
  const notice = useUiStore((s) => s.notice);
  const showNotice = useUiStore((s) => s.showNotice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className={clsx(
        'flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-[12px]',
        notice.tone === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-accent/30 bg-accent/10 text-fg',
      )}
    >
      <span className="flex-1">{notice.text}</span>
      <button type="button" onClick={() => showNotice(null)} className="rounded px-2 py-0.5 text-[11px] hover:bg-hover">
        Dismiss
      </button>
    </div>
  );
}

export function App() {
  const tickerTape = useUiStore((s) => s.settings.tickerTape);
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      {tickerTape && <TickerTape />}
      <Notice />
      <main className="min-h-0 flex-1">
        <Workspace />
      </main>
      <StatusBar />
    </div>
  );
}
