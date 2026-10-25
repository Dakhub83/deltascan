import type { DockviewApi, SerializedDockview } from 'dockview';
import { PRESETS_BY_ID } from '../scanners/presets';

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

function readNamed(): Record<string, NamedLayout> {
  try {
    return JSON.parse(localStorage.getItem(NAMED_KEY) ?? '{}') as Record<string, NamedLayout>;
  } catch {
    return {};
  }
}

function writeNamed(all: Record<string, NamedLayout>): boolean {
  try {
    localStorage.setItem(NAMED_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
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
  return Object.values(readNamed()).sort((a, b) => b.savedAt - a.savedAt);
}

/** Saves the current arrangement under `name`, replacing any layout with that name. */
export function saveLayoutAs(name: string): boolean {
  if (!api || !name.trim()) return false;
  const all = readNamed();
  all[name.trim()] = { name: name.trim(), savedAt: Date.now(), layout: api.toJSON() };
  if (!writeNamed(all)) return false;
  setActiveName(name.trim());
  return true;
}

export function loadLayout(name: string): boolean {
  const saved = readNamed()[name];
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
  const all = readNamed();
  delete all[name];
  writeNamed(all);
  if (activeLayoutName() === name) setActiveName(null);
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
