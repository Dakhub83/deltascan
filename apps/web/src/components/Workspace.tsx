import { useEffect, useState } from 'react';
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
} from 'dockview';
import {
  Crosshair,
  ExternalLink,
  Maximize2,
  Minimize2,
  OctagonPause,
  PictureInPicture2,
  Siren,
  SquareSplitHorizontal,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { FilterPanel } from '../panels/FilterPanel';
import { AlertPanel } from '../panels/AlertPanel';
import { HaltPanel } from '../panels/HaltPanel';
import { SymbolPanel } from '../panels/SymbolPanel';
import { PRESETS_BY_ID } from '../scanners/presets';
import { buildDefaultLayout, requestLayoutSave, restoreLayout, setDockApi } from '../lib/layout';
import { IconButton } from './Popover';

const theme: DockviewTheme = { name: 'scanner', className: 'dockview-theme-scanner', gap: 6 };

const components = {
  filter: FilterPanel,
  alerts: AlertPanel,
  symbol: () => <SymbolPanel />,
  halts: () => <HaltPanel />,
};

function iconFor(id: string, params: Record<string, unknown> | undefined) {
  if (id.startsWith('alerts')) return Siren;
  if (id.startsWith('symbol')) return Crosshair;
  if (id.startsWith('halts')) return OctagonPause;
  return PRESETS_BY_ID.get(String(params?.presetId))?.icon;
}

function Tab({ api, params }: IDockviewPanelHeaderProps) {
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    const d = api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  const Icon = iconFor(api.id, params);

  return (
    <div
      className="group flex h-full items-center gap-1.5 pr-0.5 text-[12px] font-medium select-none"
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          api.close();
        }
      }}
    >
      {Icon && <Icon className="size-3.5 shrink-0 text-accent/90" />}
      <span className="truncate">{title}</span>
      <button
        type="button"
        aria-label="Close window"
        onClick={(e) => {
          e.stopPropagation();
          api.close();
        }}
        className="ml-0.5 grid size-4 place-items-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function HeaderActions({ api, containerApi, group, activePanel }: IDockviewHeaderActionsProps) {
  const [maximized, setMaximized] = useState(api.isMaximized());
  const [location, setLocation] = useState(api.location.type);

  useEffect(() => {
    const a = containerApi.onDidMaximizedGroupChange(() => setMaximized(api.isMaximized()));
    const b = api.onDidLocationChange((e) => setLocation(e.location.type));
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [api, containerApi]);

  return (
    <div className="flex h-full items-center gap-0.5 px-1">
      {location === 'grid' && (
        <>
          <IconButton
            title="Float window"
            onClick={() => activePanel && containerApi.addFloatingGroup(group, { width: 640, height: 400 })}
          >
            <PictureInPicture2 className="size-3.5" />
          </IconButton>
          <IconButton title="Pop out to new window (multi-monitor)" onClick={() => void containerApi.addPopoutGroup(group)}>
            <ExternalLink className="size-3.5" />
          </IconButton>
          <IconButton
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => (maximized ? api.exitMaximized() : api.maximize())}
            className={clsx(maximized && 'text-accent')}
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </IconButton>
        </>
      )}
      {location === 'floating' && (
        <IconButton title="Dock to layout" onClick={() => api.moveTo({ position: 'right' })}>
          <SquareSplitHorizontal className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

export function Workspace() {
  const onReady = (e: DockviewReadyEvent) => {
    setDockApi(e.api);
    if (!restoreLayout()) buildDefaultLayout();
    e.api.onDidLayoutChange(requestLayoutSave);
  };

  return (
    <DockviewReact
      className="h-full"
      theme={theme}
      components={components}
      defaultTabComponent={Tab}
      rightHeaderActionsComponent={HeaderActions}
      onReady={onReady}
      popoutUrl="/popout.html"
      singleTabMode="default"
    />
  );
}
