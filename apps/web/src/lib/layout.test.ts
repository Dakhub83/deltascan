import { describe, expect, it } from 'vitest';
import type { DockviewApi } from 'dockview';
import { useUiStore } from '../store/uiStore';
import { followClick, openQuoteFor, setDockApi } from './layout';

type Fake = { id: string; component: string; location?: string; groupId?: string; visible?: boolean; params?: Record<string, unknown> };

function dock(fakes: Fake[]) {
  const panels = fakes.map((f) => {
    const panel = {
      id: f.id,
      params: f.params ?? {},
      group: { id: f.groupId ?? f.id, api: { location: { type: f.location ?? 'grid' } } },
      activated: 0,
      api: {
        component: f.component,
        isVisible: f.visible ?? true,
        setActive: () => panel.activated++,
        updateParameters: (patch: Record<string, unknown>) => Object.assign(panel.params, patch),
      },
    };
    return panel;
  });
  setDockApi({ panels, getPanel: (id: string) => panels.find((p) => p.id === id) } as unknown as DockviewApi);
  return Object.fromEntries(panels.map((p) => [p.id, p]));
}

describe('following a row click', () => {
  it('moves a quote card docked or floating in the page, leaving popped-out cards pinned', () => {
    const p = dock([
      { id: 'scan', component: 'filter' },
      { id: 'docked', component: 'quote', params: { symbol: 'AEHL' } },
      { id: 'floating', component: 'quote', location: 'floating', params: { symbol: 'AEHL' } },
      { id: 'monitor2', component: 'quote', location: 'popout', params: { symbol: 'AEHL' } },
    ]);
    followClick('PLCE');
    expect(p.docked!.params.symbol).toBe('PLCE');
    expect(p.floating!.params.symbol).toBe('PLCE');
    expect(p.monitor2!.params.symbol).toBe('AEHL');
  });

});

describe('selection changes without a row click', () => {
  it('moves quote cards in the page too', () => {
    const p = dock([{ id: 'docked', component: 'quote', params: { symbol: 'AEHL' } }]);
    useUiStore.getState().setSelectedSymbol('NVDA');
    expect(p.docked!.params.symbol).toBe('NVDA');
  });
});

describe('double-click', () => {
  it('reuses a card in the page instead of opening another window', () => {
    const p = dock([{ id: 'docked', component: 'quote', params: { symbol: 'AEHL' } }]);
    openQuoteFor('PLCE');
    expect(p.docked!.params.symbol).toBe('PLCE');
    expect(p.docked!.activated).toBe(1);
  });

  it('selects the symbol instead of opening a window while a linked tracker is on screen', () => {
    dock([{ id: 'tracker', component: 'dilution', params: { attachedTo: 'alerts' } }]);
    openQuoteFor('QQQ');
    expect(useUiStore.getState().selectedSymbol).toBe('QQQ');
  });

  it('ignores a pinned tracker and one hidden behind another tab', () => {
    const p = dock([
      { id: 'pinned', component: 'dilution', params: { linked: false, symbol: 'AEHL' } },
      { id: 'hidden', component: 'dilution', visible: false },
      { id: 'docked', component: 'quote', params: { symbol: 'AEHL' } },
    ]);
    openQuoteFor('PLCE');
    expect(p.docked!.params.symbol).toBe('PLCE');
  });
});
