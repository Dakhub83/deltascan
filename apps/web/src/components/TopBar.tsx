import { useEffect, useState, type FormEvent } from 'react';
import { Bell, BellOff, LayoutGrid, Plus, Radar, RotateCcw, Search, Settings2, Siren, Crosshair, Volume2, VolumeX, Zap } from 'lucide-react';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { addAlertWindow, addFilterWindow, addSymbolWindow, resetLayout } from '../lib/layout';
import { fmtPct, fmtPrice, signClass } from '../lib/format';
import { playTone } from '../lib/alertEffects';
import { ALERT_META } from '../lib/alertMeta';
import { PRESETS } from '../scanners/presets';
import { useUiStore } from '../store/uiStore';
import { IconButton, MenuItem, MenuLabel, Popover } from './Popover';

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

/** Re-render once a second (clock, index strip, breadth). */
function useSecondTick() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const etClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });

function sessionLabel(now: number): { label: string; cls: string } {
  const parts = Object.fromEntries(etParts.formatToParts(now).map((p) => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return { label: 'Closed', cls: 'text-muted' };
  if (mins >= 240 && mins < 570) return { label: 'Pre-market', cls: 'text-warn' };
  if (mins >= 570 && mins < 960) return { label: 'Market open', cls: 'text-up' };
  if (mins >= 960 && mins < 1200) return { label: 'After hours', cls: 'text-violet' };
  return { label: 'Closed', cls: 'text-muted' };
}

function SymbolSearch() {
  const [value, setValue] = useState('');
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sym = value.trim().toUpperCase();
    if (sym && marketData.rows.has(sym)) {
      setSelectedSymbol(sym);
      setValue('');
    }
  };
  return (
    <form onSubmit={submit} className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        list="symbol-list"
        placeholder="Symbol"
        spellCheck={false}
        className="num h-7 w-32 rounded-md border border-line bg-panel pr-2 pl-7 text-[12px] text-fg uppercase placeholder:text-muted placeholder:normal-case focus:border-accent/60 focus:outline-none"
      />
      <datalist id="symbol-list">
        {[...marketData.rows.keys()].sort().map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </form>
  );
}

function IndexStrip() {
  useSecondTick();
  const rows = [...marketData.rows.values()];
  const adv = rows.filter((r) => (r.changePct ?? 0) > 0).length;
  const dec = rows.filter((r) => (r.changePct ?? 0) < 0).length;
  const total = adv + dec || 1;

  return (
    <div className="hidden items-center gap-4 lg:flex">
      {INDEX_SYMBOLS.map((sym) => {
        const s = marketData.rows.get(sym);
        return (
          <div key={sym} className="flex items-baseline gap-1.5">
            <span className="text-[11px] font-semibold text-dim">{sym}</span>
            <span className="num text-[12px]">{fmtPrice(s?.last)}</span>
            <span className={clsx('num text-[11px]', signClass(s?.changePct))}>{fmtPct(s?.changePct)}</span>
          </div>
        );
      })}
      <div className="flex items-center gap-2" title="Advancers vs decliners">
        <span className="num text-[11px] text-up">▲ {adv}</span>
        <div className="flex h-1.5 w-20 overflow-hidden rounded-full bg-line">
          <div className="bg-up" style={{ width: `${(adv / total) * 100}%` }} />
          <div className="bg-down" style={{ width: `${(dec / total) * 100}%` }} />
        </div>
        <span className="num text-[11px] text-down">▼ {dec}</span>
      </div>
    </div>
  );
}

function ClockAndSession() {
  const now = useSecondTick();
  const session = sessionLabel(now);
  return (
    <div className="hidden items-center gap-2 md:flex">
      <span className={clsx('text-[11px] font-medium', session.cls)}>{session.label}</span>
      <span className="num text-[12px] text-dim">{etClock.format(now)} ET</span>
    </div>
  );
}

function NewWindowMenu() {
  return (
    <Popover
      trigger={(open) => (
        <button
          type="button"
          className={clsx(
            'flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors',
            open ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line bg-panel text-dim hover:border-line-strong hover:text-fg',
          )}
        >
          <Plus className="size-3.5" />
          Window
        </button>
      )}
    >
      {(close) => (
        <div className="w-64">
          <MenuLabel>Scanners</MenuLabel>
          {PRESETS.map((p) => (
            <MenuItem key={p.id} onClick={() => (addFilterWindow(p.id), close())}>
              <p.icon className="size-3.5 text-accent" />
              {p.title}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-line" />
          <MenuLabel>Tools</MenuLabel>
          <MenuItem onClick={() => (addAlertWindow(), close())}>
            <Siren className="size-3.5 text-warn" />
            Alert window
          </MenuItem>
          <MenuItem onClick={() => (addSymbolWindow(), close())}>
            <Crosshair className="size-3.5 text-cyan" />
            Symbol detail
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[12px] text-dim hover:bg-hover hover:text-fg">
      {label}
      <span className={clsx('relative h-4 w-7 rounded-full transition-colors', on ? 'bg-accent' : 'bg-line-strong')}>
        <span className={clsx('absolute top-0.5 size-3 rounded-full bg-white transition-all', on ? 'left-3.5' : 'left-0.5')} />
      </span>
    </button>
  );
}

function SettingsMenu() {
  const settings = useUiStore((s) => s.settings);
  const update = useUiStore((s) => s.updateSettings);

  const setNotifications = async (on: boolean) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return;
    }
    update({ notifications: on });
  };

  return (
    <Popover
      align="right"
      trigger={(open) => (
        <IconButton title="Settings" active={open}>
          <Settings2 className="size-4" />
        </IconButton>
      )}
    >
      {() => (
        <div className="w-60">
          <MenuLabel>Alerts</MenuLabel>
          <Toggle label="Sound" on={settings.sound} onChange={(v) => update({ sound: v })} />
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <VolumeX className="size-3.5 text-muted" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(e) => update({ volume: Number(e.target.value) })}
              onMouseUp={() => playTone(ALERT_META.new_high.tone, settings.volume)}
              className="h-1 flex-1 accent-accent"
            />
            <Volume2 className="size-3.5 text-muted" />
          </div>
          <Toggle label="Desktop notifications" on={settings.notifications} onChange={(v) => void setNotifications(v)} />
          <MenuLabel>Display</MenuLabel>
          <Toggle label="Flash price changes" on={settings.flashCells} onChange={(v) => update({ flashCells: v })} />
          <div className="my-1 h-px bg-line" />
          <MenuItem onClick={resetLayout}>
            <RotateCcw className="size-3.5" />
            Reset layout
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

export function TopBar() {
  const provider = useUiStore((s) => s.provider);
  const sound = useUiStore((s) => s.settings.sound);
  const notifications = useUiStore((s) => s.settings.notifications);
  const update = useUiStore((s) => s.updateSettings);
  const simulated = provider?.provider === 'mock';

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg px-3">
      <div className="flex items-center gap-2">
        <div className="grid size-7 place-items-center rounded-lg bg-accent/15 ring-1 ring-accent/30 ring-inset">
          <Radar className="size-4 text-accent" />
        </div>
        <span className="text-[14px] font-semibold tracking-tight">
          Delta<span className="text-accent">Scan</span>
        </span>
        {simulated && (
          <span className="flex items-center gap-1 rounded bg-warn/12 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-warn ring-1 ring-warn/25 ring-inset">
            <Zap className="size-3" />
            SIMULATED
          </span>
        )}
      </div>

      <div className="mx-1 h-5 w-px bg-line" />
      <NewWindowMenu />
      <SymbolSearch />

      <div className="ml-auto flex items-center gap-4">
        <IndexStrip />
        <ClockAndSession />
        <div className="flex items-center gap-0.5">
          <IconButton title={sound ? 'Mute alerts' : 'Unmute alerts'} onClick={() => update({ sound: !sound })} active={sound}>
            {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </IconButton>
          <IconButton title={notifications ? 'Notifications on' : 'Notifications off'} active={notifications}>
            {notifications ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          </IconButton>
          <IconButton title="Reset layout" onClick={resetLayout}>
            <LayoutGrid className="size-4" />
          </IconButton>
          <SettingsMenu />
        </div>
      </div>
    </header>
  );
}
