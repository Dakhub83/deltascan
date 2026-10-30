import type { Alert, Bar, ClientMessage, CompanyProfile, DilutionReport, FadeSignal, HaltEvent, ServerMessage, SymbolSnapshot } from '@deltascan/shared';
import { useUiStore } from '../store/uiStore';
import { upsertBar } from './chartData';

export type RowsListener = (changed: SymbolSnapshot[], reset: boolean) => void;
export type AlertsListener = (added: Alert[], reset: boolean) => void;
export type HaltsListener = (changed: HaltEvent[], reset: boolean) => void;
export type BarListener = (bar: Bar) => void;
export type ProfileResult =
  | { ok: true; profile: CompanyProfile }
  | { ok: false; reason: 'setup' | 'not-found' | 'error'; message: string };
/** Profiles are slow to build (annual report + press releases); windows showing the same symbol share one request. */
const PROFILE_TTL_MS = 2 * 60_000;
export type DilutionResult =
  | { ok: true; report: DilutionReport }
  | { ok: false; reason: 'setup' | 'not-found' | 'error'; message: string };

const MAX_ALERTS = 1_000;
const HISTORY_POINTS = 600; // 10 minutes at 1 sample/sec
const HISTORY_SAMPLE_MS = 1_000;
/** Minute-bar watchers are notified at most this often. */
const MINUTE_BARS_NOTIFY_MS = 1_000;
const MINUTE_BARS_RETRY_MS = 2_000;
/** A request cut off by a server restart can otherwise hang forever behind the dev proxy. */
const FETCH_TIMEOUT_MS = 10_000;

/** One symbol's 1-minute bars, shared by every window watching it. */
interface MinuteBarsEntry {
  bars: Bar[];
  /** Immutable copy handed to React; replaced only when something changed. */
  snapshot: Bar[];
  dirty: boolean;
  watchers: Set<() => void>;
  stop: () => void;
}
const EMPTY_BARS: Bar[] = [];
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
  /** Today's halts by id; the server re-sends a halt whenever it changes. */
  readonly halts = new Map<string, HaltEvent>();

  private readonly rowListeners = new Set<RowsListener>();
  private readonly alertListeners = new Set<AlertsListener>();
  private readonly haltListeners = new Set<HaltsListener>();
  /** Chart windows by symbol; the server streams live bars for exactly these symbols. */
  private readonly barListeners = new Map<string, Set<BarListener>>();
  private pendingRows = new Map<string, SymbolSnapshot>();
  private pendingAlerts: Alert[] = [];
  private pendingHalts = new Map<string, HaltEvent>();
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

  onHalts(fn: HaltsListener): () => void {
    this.haltListeners.add(fn);
    return () => this.haltListeners.delete(fn);
  }

  /** 1-minute bar history for a symbol, oldest first. */
  /** Short-side signals the server found for the symbol, including ones it replayed without alerting. */
  async fetchSignals(symbol: string): Promise<FadeSignal[]> {
    const res = await fetch(`/api/signals?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`signals request failed: ${res.status}`);
    return (await res.json()) as FadeSignal[];
  }

  async fetchBars(symbol: string): Promise<Bar[]> {
    const res = await fetch(`/api/bars?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`bars request failed: ${res.status}`);
    return (await res.json()) as Bar[];
  }

  private readonly profiles = new Map<string, { at: number; result: Promise<ProfileResult> }>();

  /** Description, country, ADR status and news for a symbol. */
  fetchProfile(symbol: string): Promise<ProfileResult> {
    const hit = this.profiles.get(symbol);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.result;
    const result = fetch(`/api/profile?symbol=${encodeURIComponent(symbol)}`)
      .then(async (res): Promise<ProfileResult> => {
        const body = (await res.json()) as CompanyProfile | { error: string };
        if (res.ok) return { ok: true, profile: body as CompanyProfile };
        const message = 'error' in body ? body.error : `HTTP ${res.status}`;
        return { ok: false, reason: res.status === 503 ? 'setup' : res.status === 404 ? 'not-found' : 'error', message };
      })
      .catch((): ProfileResult => ({ ok: false, reason: 'error', message: 'Could not reach the DeltaScan server' }));
    this.profiles.set(symbol, { at: Date.now(), result });
    // Don't keep failures around: the next window should retry.
    void result.then((r) => !r.ok && this.profiles.delete(symbol));
    return result;
  }

  /** SEC-based dilution report. The server caches these, so repeat calls are cheap. */
  async fetchDilution(symbol: string): Promise<DilutionResult> {
    try {
      const res = await fetch(`/api/dilution?symbol=${encodeURIComponent(symbol)}`);
      const body = (await res.json()) as DilutionReport | { error: string };
      if (res.ok) return { ok: true, report: body as DilutionReport };
      const message = 'error' in body ? body.error : `HTTP ${res.status}`;
      return { ok: false, reason: res.status === 503 ? 'setup' : res.status === 404 ? 'not-found' : 'error', message };
    } catch {
      return { ok: false, reason: 'error', message: 'Could not reach the DeltaScan server' };
    }
  }

  private readonly minuteBars = new Map<string, MinuteBarsEntry>();

  /**
   * Watches a symbol's 1-minute bars (history + live). For useSyncExternalStore: the data lives
   * here, not in a component, so React re-mounting a panel can't leave a stale copy on screen.
   */
  watchMinuteBars(symbol: string, onChange: () => void): () => void {
    let entry = this.minuteBars.get(symbol);
    if (!entry) {
      const e: MinuteBarsEntry = { bars: [], snapshot: EMPTY_BARS, dirty: false, watchers: new Set(), stop: () => {} };
      let stopped = false;
      const off = this.onBars(symbol, (bar) => {
        upsertBar(e.bars, bar);
        e.dirty = true;
      });
      const load = () =>
        this.fetchBars(symbol)
          .then((history) => {
            const last = history.at(-1)?.timestamp ?? -Infinity;
            e.bars = [...history, ...e.bars.filter((b) => b.timestamp > last)];
            e.dirty = true;
            flush();
          })
          .catch(() => !stopped && setTimeout(load, MINUTE_BARS_RETRY_MS));
      const flush = () => {
        if (!e.dirty) return;
        e.dirty = false;
        e.snapshot = [...e.bars];
        e.watchers.forEach((fn) => fn());
      };
      const timer = setInterval(flush, MINUTE_BARS_NOTIFY_MS);
      e.stop = () => {
        stopped = true;
        off();
        clearInterval(timer);
      };
      void load();
      this.minuteBars.set(symbol, (entry = e));
    }
    const current = entry;
    current.watchers.add(onChange);
    return () => {
      current.watchers.delete(onChange);
      if (current.watchers.size) return;
      current.stop();
      this.minuteBars.delete(symbol);
    };
  }

  getMinuteBars(symbol: string): Bar[] {
    return this.minuteBars.get(symbol)?.snapshot ?? EMPTY_BARS;
  }

  /** Live updates of a symbol's current 1-minute bar. */
  onBars(symbol: string, fn: BarListener): () => void {
    let set = this.barListeners.get(symbol);
    if (!set) this.barListeners.set(symbol, (set = new Set()));
    set.add(fn);
    this.sendChartSymbols();
    return () => {
      set.delete(fn);
      if (!set.size) this.barListeners.delete(symbol);
      this.sendChartSymbols();
    };
  }

  private sendChartSymbols(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg: ClientMessage = { type: 'chart', symbols: [...this.barListeners.keys()] };
    this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    useUiStore.setState({ socket: 'connecting' });

    ws.onopen = () => {
      this.attempt = 0;
      useUiStore.setState({ socket: 'open' });
      this.sendChartSymbols();
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
        this.halts.clear();
        for (const h of msg.data.halts) this.halts.set(h.id, h);
        this.pendingRows.clear();
        this.pendingAlerts = [];
        this.pendingHalts.clear();
        useUiStore.setState({ provider: msg.data.status, session: msg.data.session });
        const all = [...this.rows.values()];
        this.rowListeners.forEach((fn) => fn(all, true));
        this.alertListeners.forEach((fn) => fn(this.alerts, true));
        const halts = [...this.halts.values()];
        this.haltListeners.forEach((fn) => fn(halts, true));
        break;
      }
      case 'bars':
        for (const bar of msg.data) this.barListeners.get(bar.symbol)?.forEach((fn) => fn(bar));
        break;
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
      case 'halts':
        for (const h of msg.data) {
          this.halts.set(h.id, h);
          this.pendingHalts.set(h.id, h);
        }
        this.scheduleFlush();
        break;
      case 'status':
        useUiStore.setState({ provider: msg.data });
        break;
      case 'stats':
        useUiStore.setState({ stats: msg.data, session: msg.data.session });
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
    if (this.pendingHalts.size) {
      const changed = [...this.pendingHalts.values()];
      this.pendingHalts.clear();
      this.haltListeners.forEach((fn) => fn(changed, false));
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
