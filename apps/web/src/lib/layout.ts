import type { DockviewApi, DockviewGroupPanel, IDockviewPanel, SerializedDockview } from 'dockview';
import { PRESETS_BY_ID } from '../scanners/presets';
import { useUiStore } from '../store/uiStore';

const STORAGE_KEY = 'deltascan.layout.v1';
const NAMED_KEY = 'deltascan.layouts.v1';
const ACTIVE_KEY = 'deltascan.layout.active';
const SAVE_DEBOUNCE_MS = 500;

let api: DockviewApi | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function setDockApi(next: DockviewApi): void {
  api = next;
}

const uid = () => Math.random().toString(36).slice(2, 8);

export function requestLayoutSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!api) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(api.toJSON()));
    } catch {
      /* storage full / unavailable: layout just won't persist */
    }
  }, SAVE_DEBOUNCE_MS);
}

export function restoreLayout(): boolean {
  if (!api) return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    api.fromJSON(JSON.parse(raw));
    return api.panels.length > 0;
  } catch {
    return false;
  }
}

export interface NamedLayout {
  name: string;
  savedAt: number;
  layout: SerializedDockview;
}

/**
 * Named layouts live on the server (per account, every device). This copy keeps the Layouts menu
 * instant; writes go to the server in the background and report failures in the notice bar.
 */
const named = new Map<string, NamedLayout>();
const layoutUrl = (name: string) => `/api/layouts/${encodeURIComponent(name)}`;

function reportFailure(action: string) {
  return (err: unknown) => useUiStore.getState().showNotice(`Couldn't ${action} on the server: ${(err as Error).message}`, 'warn');
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res;
}

function putLayout(entry: NamedLayout): Promise<unknown> {
  return request(layoutUrl(entry.name), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ savedAt: entry.savedAt, layout: entry.layout }),
  });
}

/**
 * Loads the account's saved layouts. Layouts saved in this browser before they moved to the
 * server are uploaded once, then removed from the browser.
 */
export async function syncLayouts(): Promise<void> {
  const list = (await (await request('/api/layouts')).json()) as { name: string; updatedAt: number }[];
  const loaded = await Promise.all(
    list.map(async ({ name, updatedAt }) => {
      const data = (await (await request(layoutUrl(name))).json()) as { savedAt?: number; layout: SerializedDockview };
      return { name, savedAt: data.savedAt ?? updatedAt, layout: data.layout } satisfies NamedLayout;
    }),
  );
  named.clear();
  for (const l of loaded) named.set(l.name, l);

  let local: Record<string, NamedLayout> = {};
  try {
    local = JSON.parse(localStorage.getItem(NAMED_KEY) ?? '{}') as Record<string, NamedLayout>;
  } catch {
    /* unreadable: nothing to move */
  }
  const toUpload = Object.values(local).filter((l) => l?.name && l.layout && !named.has(l.name));
  await Promise.all(toUpload.map((l) => putLayout(l).then(() => named.set(l.name, l))));
  try {
    localStorage.removeItem(NAMED_KEY);
  } catch {
    /* ignore */
  }
}

function setActiveName(name: string | null): void {
  try {
    if (name) localStorage.setItem(ACTIVE_KEY, name);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** Name of the saved layout last saved or loaded, if any. */
export function activeLayoutName(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** Saved layouts, newest first. */
export function listLayouts(): NamedLayout[] {
  return [...named.values()].sort((a, b) => b.savedAt - a.savedAt);
}

/** Saves the current arrangement under `name`, replacing any layout with that name. */
export function saveLayoutAs(name: string): boolean {
  const trimmed = name.trim();
  if (!api || !trimmed || trimmed.length > 80) return false;
  const entry: NamedLayout = { name: trimmed, savedAt: Date.now(), layout: api.toJSON() };
  named.set(trimmed, entry);
  putLayout(entry).catch(reportFailure(`save the layout "${trimmed}"`));
  setActiveName(trimmed);
  return true;
}

export function loadLayout(name: string): boolean {
  const saved = named.get(name);
  if (!api || !saved) return false;
  try {
    api.fromJSON(saved.layout);
  } catch {
    return false;
  }
  setActiveName(name);
  requestLayoutSave();
  return true;
}

export function deleteLayout(name: string): void {
  named.delete(name);
  request(layoutUrl(name), { method: 'DELETE' }).catch(reportFailure(`delete the layout "${name}"`));
  if (activeLayoutName() === name) setActiveName(null);
}

// ── Layout files ──

/** The File System Access API (Chrome/Edge); TypeScript's DOM types don't include it yet. */
interface FilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ name: string; createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }>;
}

interface LayoutFile {
  app: 'DeltaScan';
  kind: 'layout';
  version: 1;
  name: string;
  savedAt: string;
  layout: SerializedDockview;
}

/**
 * Saves the current layout as a JSON file. Chrome and Edge show a Save dialog so the trader picks
 * the folder; other browsers download it. Must be called straight from a click: the dialog
 * needs a user gesture, so nothing may be awaited before it opens.
 */
export async function saveLayoutToFile(name: string): Promise<{ status: 'saved' | 'downloaded' | 'cancelled'; fileName: string }> {
  if (!api) throw new Error('Layout not ready');
  const file: LayoutFile = { app: 'DeltaScan', kind: 'layout', version: 1, name, savedAt: new Date().toISOString(), layout: api.toJSON() };
  const data = JSON.stringify(file, null, 2);
  const suggestedName = `${name.replace(/[\/:*?"<>|]+/g, '-').trim() || 'deltascan-layout'}.json`;

  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description: 'DeltaScan layout', accept: { 'application/json': ['.json'] } }] });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return { status: 'saved', fileName: handle.name };
    } catch (err) {
      if ((err as Error).name === 'AbortError') return { status: 'cancelled', fileName: suggestedName };
      throw err;
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: suggestedName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { status: 'downloaded', fileName: suggestedName };
}

/** Applies a layout file's contents. Throws a readable error if it isn't a DeltaScan layout. */
export function loadLayoutFromText(text: string): string {
  if (!api) throw new Error('Layout not ready');
  let file: Partial<LayoutFile>;
  try {
    file = JSON.parse(text) as Partial<LayoutFile>;
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (file.app !== 'DeltaScan' || file.kind !== 'layout' || !file.layout) throw new Error("That file isn't a DeltaScan layout.");
  const previous = api.toJSON();
  try {
    api.fromJSON(file.layout);
  } catch {
    api.fromJSON(previous);
    throw new Error("That layout file couldn't be opened; your current layout was kept.");
  }
  setActiveName(null);
  requestLayoutSave();
  return file.name ?? 'layout';
}

/** New windows open floating so they're immediately visible; drag a tab to dock it. */
const floating = () => ({ width: 640, height: 400, x: 120 + Math.random() * 120, y: 80 + Math.random() * 80 });

export function addFilterWindow(presetId: string): void {
  const preset = PRESETS_BY_ID.get(presetId);
  if (!api || !preset) return;
  api.addPanel({ id: `filter-${presetId}-${uid()}`, component: 'filter', title: preset.title, params: { presetId }, floating: floating() });
}

export function addAlertWindow(): void {
  api?.addPanel({ id: `alerts-${uid()}`, component: 'alerts', title: 'Alerts', params: {}, floating: floating() });
}

export function addSymbolWindow(): void {
  api?.addPanel({ id: `symbol-${uid()}`, component: 'symbol', title: 'Symbol', params: {}, floating: { ...floating(), width: 380, height: 520 } });
}

/**
 * Opens the Dilution window in its own browser window, so it can sit on another monitor and
 * follow whatever you click. Stays floating if the browser blocks the pop-up.
 */
/**
 * The Dilution tracker, docked in the layout as a tab beside the Symbol / Chart windows (or on
 * the right if those are closed). A pinned symbol that already has one, or the linked tracker
 * when no symbol is given, is brought forward instead of opening a duplicate.
 */
export function addDilutionWindow(params: { symbol?: string; linked?: boolean } = {}): void {
  if (!api) return;
  const existing = api.panels.find((p) => {
    if (p.api.component !== 'dilution') return false;
    const current = p.params as { symbol?: string; linked?: boolean } | undefined;
    return params.symbol ? current?.linked === false && current.symbol === params.symbol : current?.linked !== false;
  });
  if (existing) return existing.api.setActive();
  const neighbour = api.panels.find((p) => p.api.component === 'symbol' || p.api.component === 'chart');
  const panel = api.addPanel({
    id: `dilution-${uid()}`,
    component: 'dilution',
    title: 'Dilution',
    params,
    position: neighbour ? { referencePanel: neighbour.id, direction: 'within' } : { direction: 'right' },
  });
  panel.api.setActive();
}

const ATTACHED_WIDTH = 440;

/** The Dilution tracker attached to window group `groupId`, if it has one. */
export function attachedDilution(groupId: string): IDockviewPanel | undefined {
  return api?.panels.find((p) => p.api.component === 'dilution' && (p.params as { attachedTo?: string } | undefined)?.attachedTo === groupId);
}

/**
 * Attaches a linked Dilution tracker to the right of `group` (any window), or removes it again.
 * A docked window gets a split that moves and resizes with the layout; a floating one gets a
 * floating tracker butted against its right edge.
 */
export function toggleAttachedDilution(group: DockviewGroupPanel): void {
  if (!api) return;
  const existing = attachedDilution(group.id);
  if (existing) return existing.api.close();
  const params = { linked: true, attachedTo: group.id };
  const base = { id: `dilution-${uid()}`, component: 'dilution', title: 'Dilution', params };
  if (group.api.location.type === 'floating') {
    const root = group.element.closest('.dv-dockview')?.getBoundingClientRect();
    const box = (group.element.closest('.dv-resize-container') ?? group.element).getBoundingClientRect();
    const left = root ? box.right - root.left : 0;
    const width = root ? Math.min(ATTACHED_WIDTH, Math.max(320, root.width - left)) : ATTACHED_WIDTH;
    // No room on the right: overlap the window's right edge instead, as the quote card does.
    const x = root && left + width > root.width ? Math.max(0, root.width - width) : left;
    api.addPanel({ ...base, floating: { x, y: root ? box.top - root.top : 0, width, height: Math.max(360, box.height) } }).api.setActive();
    return;
  }
  const before = group.api.width;
  const panel = api.addPanel({ ...base, position: { referenceGroup: group.id, direction: 'right' } });
  // Never squeeze the window it's attached to below about half its width.
  panel.group.api.setSize({ width: Math.min(ATTACHED_WIDTH, Math.round(before * 0.45)) });
  panel.api.setActive();
}

/** Opens `component` in its own browser window, cascaded so repeat windows don't stack exactly. */
function popOut(component: string, title: string, params: object, width: number, height: number): void {
  if (!api) return;
  const dock = api;
  const offset = (dock.panels.filter((p) => p.api.component === component).length % 6) * 28;
  const add = () => dock.addPanel({ id: `${component}-${uid()}`, component, title, params, floating: { ...floating(), width, height } });
  const panel = add();
  // dockview adds window.screenX/Y itself, so the position is relative to this window.
  const position = { left: Math.max(0, window.outerWidth - width - 40) - offset, top: 80 + offset, width, height };
  void dock.addPopoutGroup(panel, { position }).then((opened) => {
    if (opened) return;
    // Pop-up blocked: dockview drops the panel, so show it floating in this window instead.
    if (!dock.getPanel(panel.id)) add().api.setActive();
    useUiStore.getState().showNotice(
      'Your browser blocked the pop-up window, so it opened here instead. Allow pop-ups for this site (icon at the right of the address bar) to get separate windows.',
    );
  });
}

const DOUBLE_CLICK_MS = 450;

/**
 * Returns a row-click handler that calls `onDouble` on a second click of the same symbol.
 * Native dblclick is unreliable in live grids: the browser only fires it when both clicks hit
 * the same element, and cells are re-rendered (price flashes) and rows re-sorted between clicks.
 */
export function symbolDoubleClick(onDouble: (symbol: string) => void): (symbol: string) => void {
  let last = { symbol: '', at: 0 };
  return (symbol) => {
    const now = performance.now();
    if (symbol === last.symbol && now - last.at < DOUBLE_CLICK_MS) {
      last = { symbol: '', at: 0 };
      onDouble(symbol);
    } else {
      last = { symbol, at: now };
    }
  };
}

/**
 * Double-click on a symbol: a quote card pinned to it, in its own browser window. If that
 * symbol already has one, bring it to the front instead of opening a duplicate.
 */
export function openQuoteFor(symbol: string, fromPanelId?: string): void {
  if (!api) return;
  // The window has its own Dilution tracker, which already follows the click: no extra window.
  const from = fromPanelId ? api.getPanel(fromPanelId) : undefined;
  const attached = from ? attachedDilution(from.group.id) : undefined;
  if (attached) return attached.api.setActive();
  const existing = api.panels.find((p) => p.api.component === 'quote' && (p.params as { symbol?: string } | undefined)?.symbol === symbol);
  if (!existing) return popOut('quote', `${symbol} · Quote`, { symbol }, 440, 820);
  existing.api.setActive();
  const location = existing.group.api.location;
  if (location.type === 'popout') location.getWindow().focus();
}

export function addShortCalcWindow(): void {
  api?.addPanel({ id: `shortcalc-${uid()}`, component: 'shortcalc', title: 'Short calc', params: {}, floating: { ...floating(), width: 480, height: 620 } });
}

export function addChartWindow(): void {
  api?.addPanel({ id: `chart-${uid()}`, component: 'chart', title: 'Chart', params: {}, floating: { ...floating(), width: 820, height: 480 } });
}

export function addWatchlistWindow(): void {
  api?.addPanel({ id: `watchlist-${uid()}`, component: 'watchlist', title: 'My watchlist', params: {}, floating: { ...floating(), width: 720, height: 340 } });
}

export function addNewHighsWindow(): void {
  api?.addPanel({ id: `newhighs-${uid()}`, component: 'newhighs', title: 'New highs', params: {}, floating: { ...floating(), width: 760, height: 380 } });
}

export function addHaltWindow(): void {
  api?.addPanel({ id: `halts-${uid()}`, component: 'halts', title: 'Halts', params: {}, floating: { ...floating(), width: 760, height: 320 } });
}

export function buildDefaultLayout(): void {
  if (!api) return;
  api.clear();
  const filter = (id: string, presetId: string, position?: Parameters<DockviewApi['addPanel']>[0]['position']) =>
    api!.addPanel({
      id,
      component: 'filter',
      title: PRESETS_BY_ID.get(presetId)!.title,
      params: { presetId },
      ...(position ? { position } : {}),
    });

  // Columns first (left | middle | right), then split each column vertically.
  const gainers = filter('gainers', 'top-gainers');
  const rvol = filter('rvol', 'high-rvol', { referencePanel: 'gainers', direction: 'right' });
  const alerts = api.addPanel({
    id: 'alerts',
    component: 'alerts',
    title: 'Alerts',
    params: {},
    position: { referencePanel: 'rvol', direction: 'right' },
  });
  api.addPanel({
    id: 'halts',
    component: 'halts',
    title: 'Halts',
    params: {},
    position: { referencePanel: 'alerts', direction: 'within' },
  });
  alerts.api.setActive();

  filter('momentum', 'momentum', { referencePanel: 'gainers', direction: 'within' });
  filter('losers', 'top-losers', { referencePanel: 'gainers', direction: 'within' });
  filter('gaps', 'gap-ups', { referencePanel: 'gainers', direction: 'below' });
  const runners = filter('runners', 'low-float-runners', { referencePanel: 'rvol', direction: 'below' });
  filter('hod', 'near-hod', { referencePanel: 'runners', direction: 'within' });
  filter('vwap', 'vwap-leaders', { referencePanel: 'runners', direction: 'within' });
  api.addPanel({
    id: 'symbol',
    component: 'symbol',
    title: 'Symbol',
    params: {},
    position: { referencePanel: 'alerts', direction: 'below' },
  });

  const chart = api.addPanel({
    id: 'chart',
    component: 'chart',
    title: 'Chart',
    params: {},
    position: { referencePanel: 'symbol', direction: 'within' },
  });

  api.addPanel({
    id: 'dilution',
    component: 'dilution',
    title: 'Dilution',
    params: {},
    position: { referencePanel: 'symbol', direction: 'within' },
  });

  chart.api.setActive();
  gainers.api.setActive();
  runners.api.setActive();

  const w = api.width || window.innerWidth;
  const h = api.height || window.innerHeight;
  gainers.group.api.setSize({ width: Math.round(w * 0.37), height: Math.round(h * 0.55) });
  rvol.group.api.setSize({ width: Math.round(w * 0.33), height: Math.round(h * 0.5) });
  alerts.group.api.setSize({ height: Math.round(h * 0.56) });
}

export function resetLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  setActiveName(null);
  buildDefaultLayout();
}
