import { TopBar } from './components/TopBar';
import { StatusBar } from './components/StatusBar';
import { Workspace } from './components/Workspace';
import { useUiStore } from './store/uiStore';

function Notice() {
  const notice = useUiStore((s) => s.notice);
  const showNotice = useUiStore((s) => s.showNotice);
  if (!notice) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
      <span className="flex-1">{notice}</span>
      <button type="button" onClick={() => showNotice(null)} className="rounded px-2 py-0.5 text-[11px] hover:bg-warn/15">
        Dismiss
      </button>
    </div>
  );
}

export function App() {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <Notice />
      <main className="min-h-0 flex-1">
        <Workspace />
      </main>
      <StatusBar />
    </div>
  );
}
