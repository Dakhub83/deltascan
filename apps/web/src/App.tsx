import { TopBar } from './components/TopBar';
import { StatusBar } from './components/StatusBar';
import { Workspace } from './components/Workspace';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="min-h-0 flex-1">
        <Workspace />
      </main>
      <StatusBar />
    </div>
  );
}
