import type { Alert, ServerMessage, SymbolSnapshot } from '@deltascan/shared';
import { useUiStore } from '../store/uiStore';

export type RowsListener = (changed: SymbolSnapshot[], reset: boolean) => void;
export type AlertsListener = (added: Alert[], reset: boolean) => void;

const MAX_ALERTS = 1_000;
const HISTORY_POINTS = 600; // 10 minutes at 1 sample/sec
const HISTORY_SAMPLE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/**
 * Single WebSocket to the server, shared by every window.
 *
 * Tick data deliberately lives OUTSIDE React: rows sit in a mutable Map and listeners
 * (grids) receive coalesced batches once per animation frame, so a burst of updates
 * costs one grid transaction instead of hundreds of React renders.
 */
class MarketDataClient {
  readonly rows = new Map<string, SymbolSnapshot>();
  /** Newest first. */
  alerts: Alert[] = [];
  readonly history = new Map<string, number[]>();

  private readonly rowListeners = new Set<RowsListener>();
  private readonly alertListeners = new Set<AlertsListener>();
  private pendingRows = new Map<string, SymbolSnapshot>();
  private pendingAlerts: Alert[] = [];
  private flushScheduled = false;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
    setInterval(() => this.sampleHistory(), HISTORY_SAMPLE_MS);
  }

  onRows(fn: RowsListener): () => void {
    this.rowListeners.add(fn);
    return () => this.rowListeners.delete(fn);
  }

  onAlerts(fn: AlertsListener): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    useUiStore.setState({ socket: 'connecting' });

    ws.onopen = () => {
      this.attempt = 0;
      useUiStore.setState({ socket: 'open' });
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data as string) as ServerMessage);
    ws.onclose = () => {
      this.ws = null;
      useUiStore.setState({ socket: 'closed' });
      const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private handle(msg: ServerMessage): void {
    useUiStore.setState({ lastMessageAt: Date.now() });
    switch (msg.type) {
      case 'hello': {
        this.rows.clear();
        for (const s of msg.data.snapshots) this.rows.set(s.symbol, s);
        this.alerts = msg.data.alerts.slice(0, MAX_ALERTS);
        this.pendingRows.clear();
        this.pendingAlerts = [];
        useUiStore.setState({ provider: msg.data.status });
        const all = [...this.rows.values()];
        this.rowListeners.forEach((fn) => fn(all, true));
        this.alertListeners.forEach((fn) => fn(this.alerts, true));
        break;
      }
      case 'snapshots':
        for (const s of msg.data) {
          this.rows.set(s.symbol, s);
          this.pendingRows.set(s.symbol, s);
        }
        this.scheduleFlush();
        break;
      case 'alerts':
        // Server sends oldest → newest; keep newest first locally.
        for (const a of msg.data) this.pendingAlerts.unshift(a);
        this.scheduleFlush();
        break;
      case 'status':
        useUiStore.setState({ provider: msg.data });
        break;
      case 'stats':
        useUiStore.setState({ stats: msg.data });
        break;
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // rAF pauses in background tabs; popped-out windows still need updates then.
    if (document.hidden) setTimeout(() => this.flush(), 100);
    else requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pendingRows.size) {
      const changed = [...this.pendingRows.values()];
      this.pendingRows.clear();
      this.rowListeners.forEach((fn) => fn(changed, false));
    }
    if (this.pendingAlerts.length) {
      const added = this.pendingAlerts;
      this.pendingAlerts = [];
      this.alerts = added.concat(this.alerts).slice(0, MAX_ALERTS);
      this.alertListeners.forEach((fn) => fn(added, false));
    }
  }

  private sampleHistory(): void {
    for (const [symbol, s] of this.rows) {
      if (s.last === null) continue;
      let h = this.history.get(symbol);
      if (!h) this.history.set(symbol, (h = []));
      h.push(s.last);
      if (h.length > HISTORY_POINTS) h.shift();
    }
  }
}

export const marketData = new MarketDataClient();
