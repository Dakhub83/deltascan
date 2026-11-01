import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { App } from './App';
import { AuthGate } from './components/AuthGate';
import { marketData } from './lib/marketData';
import { installAlertEffects } from './lib/alertEffects';
import { syncLayouts } from './lib/layout';
import { useUiStore } from './store/uiStore';
import { useWatchlistStore } from './store/watchlistStore';

function start(): void {
  marketData.start();
  installAlertEffects();
  void useWatchlistStore.getState().load();
  syncLayouts().catch((err: Error) => useUiStore.getState().showNotice(`Couldn't load your saved layouts: ${err.message}`, 'warn'));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate onReady={start}>
      <App />
    </AuthGate>
  </StrictMode>,
);
