import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import type { SymbolSnapshot } from '@deltascan/shared';
import { AlertTriangle, Link2, Link2Off, Plus, Settings2, X } from 'lucide-react';
import clsx from 'clsx';
import { marketData } from '../lib/marketData';
import { fmtCompact, fmtPrice } from '../lib/format';
import { requestLayoutSave } from '../lib/layout';
import { DEFAULT_SHORT_LIMITS, planShort, type ShortLimits } from '../lib/shortPlan';
import { useUiStore } from '../store/uiStore';

export interface ShortCalcParams {
  symbol?: string | null;
  linked?: boolean;
  /** Raw input text, so half-typed values survive a layout save. */
  stop?: string;
  entries?: string[];
}

const LIMIT_FIELDS: { key: keyof ShortLimits; label: string; step: string; prefix?: string }[] = [
  { key: 'maxRisk', label: 'Max risk per ticker', step: '10', prefix: '$' },
  { key: 'maxShares', label: 'Max shares', step: '100' },
  { key: 'maxLots', label: 'Max lots', step: '1' },
  { key: 'premarketMaxShares', label: 'Pre-market probe cap', step: '10' },
  { key: 'addStopOffset', label: 'Add stop: last entry +', step: '0.01', prefix: '$' },
  { key: 'hotkeyOffset', label: 'DAS hotkey: avg cost ±', step: '0.01', prefix: '$' },
  { key: 'minStopDistance', label: 'Warn if first stop under', step: '0.01', prefix: '$' },
  { key: 'starterPct', label: 'Front-side starter (% of size)', step: '5' },
];

const num = (s: string | undefined) => (s && s.trim() !== '' ? Number(s) : Number.NaN);
const usd = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;

function useLiveRow(symbol: string | null): SymbolSnapshot | null {
  const [row, setRow] = useState(() => (symbol ? marketData.rows.get(symbol) ?? null : null));
  useEffect(() => {
    setRow(symbol ? marketData.rows.get(symbol) ?? null : null);
    if (!symbol) return;
    return marketData.onRows((changed, reset) => {
      if (reset || changed.some((s) => s.symbol === symbol)) setRow(marketData.rows.get(symbol) ?? null);
    });
  }, [symbol]);
  return row;
}

function PriceInput({ value, onChange, label, children }: { value: string; onChange: (v: string) => void; label: string; children?: ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[11px] text-dim">{label}</span>
      <span className="flex h-7 flex-1 items-center rounded-md border border-line bg-bg focus-within:border-accent/60">
        <span className="pl-2 text-[12px] text-muted">$</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          className="num h-full w-full min-w-0 bg-transparent px-1 text-[12px] text-fg outline-none"
        />
      </span>
      {children}
    </label>
  );
}

function LimitsEditor({ onDone }: { onDone: () => void }) {
  const limits = useUiStore((s) => s.settings.shortLimits);
  const updateSettings = useUiStore((s) => s.updateSettings);
  const [draft, setDraft] = useState(() => Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(limits[f.key])])));

  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = { ...limits };
    for (const f of LIMIT_FIELDS) {
      const v = Number(draft[f.key]);
      if (Number.isFinite(v) && v > 0 && (f.key !== 'starterPct' || v < 100)) next[f.key] = v;
    }
    updateSettings({ shortLimits: next, shortLimitsSet: true });
    onDone();
  };

  return (
    <form onSubmit={save} className="rounded-lg border border-line bg-raised/60 p-3">
      <div className="mb-2 text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">Your limits (all tickers)</div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 @[460px]:grid-cols-2">
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-2 text-[11px] text-dim">
            {f.label}
            <span className="flex h-6 w-24 items-center rounded border border-line bg-bg focus-within:border-accent/60">
              {f.prefix && <span className="pl-1.5 text-muted">{f.prefix}</span>}
              <input
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                inputMode="decimal"
                className="num w-full min-w-0 bg-transparent px-1 text-right text-[11px] text-fg outline-none"
              />
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => setDraft(Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(DEFAULT_SHORT_LIMITS[f.key])])))} className="rounded-md px-2.5 py-1 text-[11px] text-muted hover:text-fg">
          Defaults
        </button>
        <button type="submit" className="rounded-md bg-accent px-3 py-1 text-[11px] font-medium text-white">
          Save limits
        </button>
      </div>
    </form>
  );
}

export function ShortCalcPanel({ params, api: panelApi }: IDockviewPanelProps<ShortCalcParams>) {
  const linked = params.linked ?? true;
  const selected = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const limits = useUiStore((s) => s.settings.shortLimits);
  const limitsSet = useUiStore((s) => s.settings.shortLimitsSet);
  const premarket = useUiStore((s) => s.session === 'pre');
  const symbol = (linked ? selected : params.symbol) ?? null;
  const row = useLiveRow(symbol);
  const [draft, setDraft] = useState('');
  const [editingLimits, setEditingLimits] = useState(false);

  const stop = params.stop ?? '';
  const entries = params.entries?.length ? params.entries : [''];
  const update = (patch: Partial<ShortCalcParams>) => {
    panelApi.updateParameters(patch);
    requestLayoutSave();
  };

  useEffect(() => panelApi.setTitle(symbol ? `${symbol} · Short calc` : 'Short calc'), [panelApi, symbol]);

  // A new symbol (or a new, empty window) starts a fresh plan, prefilled with its current price.
  const [planFor, setPlanFor] = useState(params.entries?.length ? symbol : null);
  useEffect(() => {
    if (symbol === planFor) return;
    setPlanFor(symbol);
    const last = symbol ? marketData.rows.get(symbol)?.last : null;
    update({ stop: '', entries: [last != null ? fmtPrice(last) : ''] });
  }, [symbol]);

  const spread = row?.bid != null && row?.ask != null && row.ask >= row.bid ? row.ask - row.bid : null;
  const plan = useMemo(
    () => planShort({ stop: num(stop), entries: entries.map(num), premarket, spread }, limits),
    [stop, entries.join('|'), premarket, spread, limits],
  );
  const last = plan.lots.at(-1);
  const peakRisk = plan.lots.reduce((m, l) => Math.max(m, l.openRisk), 0);
  const riskPct = Math.min(100, Math.max(0, (peakRisk / limits.maxRisk) * 100));

  const setEntry = (i: number, v: string) => update({ entries: entries.map((e, j) => (j === i ? v : e)) });
  const submitSymbol = (e: FormEvent) => {
    e.preventDefault();
    const sym = draft.trim().toUpperCase();
    setDraft('');
    if (!sym) return;
    if (linked) setSelectedSymbol(sym);
    else update({ symbol: sym });
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <form onSubmit={submitSymbol}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={symbol ?? 'Symbol'}
            aria-label="Calculator symbol"
            maxLength={10}
            className="h-6 w-20 rounded-md border border-line bg-bg px-2 text-[12px] font-semibold text-fg uppercase outline-none placeholder:font-semibold placeholder:text-fg placeholder:normal-case focus:border-accent/60 focus:placeholder:text-muted"
          />
        </form>
        <button
          type="button"
          onClick={() => (linked ? update({ linked: false, symbol }) : update({ linked: true }))}
          title={linked ? 'Linked to the selected symbol. Click to pin.' : 'Pinned. Click to follow the selected symbol.'}
          aria-label={linked ? 'Unlink from selection' : 'Link to selection'}
          className={clsx('grid size-6 place-items-center rounded-md transition-colors hover:bg-hover', linked ? 'text-accent' : 'text-muted hover:text-fg')}
        >
          {linked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}
        </button>
        {premarket && <span className="rounded bg-warn/15 px-1.5 py-px text-[10px] font-semibold text-warn">PRE-MARKET · PROBE ONLY</span>}
        <button
          type="button"
          onClick={() => setEditingLimits((v) => !v)}
          title="Edit your limits"
          aria-label="Edit limits"
          className={clsx('ml-auto grid size-6 place-items-center rounded-md hover:bg-hover', editingLimits ? 'text-accent' : 'text-muted hover:text-fg')}
        >
          <Settings2 className="size-3.5" />
        </button>
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-3">
          {!limitsSet && !editingLimits && (
            <button type="button" onClick={() => setEditingLimits(true)} className="rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-left text-[11px] text-warn">
              Using placeholder limits (${limits.maxRisk} risk, {fmtCompact(limits.maxShares)} shares). Click to set your own.
            </button>
          )}
          {editingLimits && <LimitsEditor onDone={() => setEditingLimits(false)} />}

          {row && (
            <div className="num flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
              <span>
                Last <span className="text-fg">{fmtPrice(row.last)}</span>
              </span>
              <span>
                Bid/Ask <span className="text-dim">{fmtPrice(row.bid)} / {fmtPrice(row.ask)}</span>
              </span>
              <span>
                HOD <span className="text-dim">{fmtPrice(row.high)}</span>
              </span>
              <span>
                VWAP <span className="text-dim">{fmtPrice(row.vwap)}</span>
              </span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <PriceInput label="Stop (lot 1)" value={stop} onChange={(v) => update({ stop: v })}>
              {row?.high != null && (
                <button type="button" onClick={() => update({ stop: fmtPrice(row.high! + 0.05) })} className="shrink-0 rounded px-1.5 py-1 text-[10px] text-accent hover:bg-hover" title="Stop just above the high of day">
                  HOD +5¢
                </button>
              )}
            </PriceInput>
            {entries.map((e, i) => (
              <PriceInput key={i} label={i === 0 ? 'Entry' : `Add zone ${i}`} value={e} onChange={(v) => setEntry(i, v)}>
                {i === 0 && row?.last != null ? (
                  <button type="button" onClick={() => setEntry(0, fmtPrice(row.last))} className="shrink-0 rounded px-1.5 py-1 text-[10px] text-accent hover:bg-hover">
                    Last
                  </button>
                ) : i > 0 ? (
                  <button type="button" onClick={() => update({ entries: entries.filter((_, j) => j !== i) })} aria-label={`Remove add zone ${i}`} className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-hover hover:text-fg">
                    <X className="size-3" />
                  </button>
                ) : null}
              </PriceInput>
            ))}
            <button type="button" onClick={() => update({ entries: [...entries, ''] })} className="flex items-center gap-1 self-start rounded px-1.5 py-1 text-[11px] text-accent hover:bg-hover">
              <Plus className="size-3" /> Add zone
            </button>
          </div>

          {plan.error ? (
            <p className="text-[11px] text-muted">{plan.error}</p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="num w-full text-right text-[11px]">
                  <thead className="text-[10px] tracking-wider text-muted uppercase">
                    <tr className="border-b border-line">
                      <th className="px-2 py-1.5 text-left font-semibold">Lot</th>
                      <th className="px-2 py-1.5 font-semibold">Entry</th>
                      <th className="px-2 py-1.5 font-semibold">Shares</th>
                      <th className="px-2 py-1.5 font-semibold">Total</th>
                      <th className="px-2 py-1.5 font-semibold">Avg</th>
                      <th className="px-2 py-1.5 font-semibold">Stop</th>
                      <th className="px-2 py-1.5 font-semibold">Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.lots.map((l, i) => (
                      <tr key={i} className={clsx('border-b border-line/60 last:border-0', l.shares === 0 && 'text-muted')}>
                        <td className="px-2 py-1.5 text-left font-sans text-dim">{i === 0 ? 'Entry' : `Add ${i}`}</td>
                        <td className="px-2 py-1.5 text-fg">{fmtPrice(l.entry)}</td>
                        <td className="px-2 py-1.5 font-semibold text-fg">{l.shares.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-dim">{l.totalShares.toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-dim">{fmtPrice(l.avgCost)}</td>
                        <td className="px-2 py-1.5 text-warn">{fmtPrice(l.stop)}</td>
                        <td className={clsx('px-2 py-1.5', l.openRisk <= 0 ? 'text-up' : 'text-dim')}>{usd(l.openRisk)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <div className="mb-1 flex justify-between text-[10px] tracking-wider text-muted uppercase">
                  <span>Risk used (peak)</span>
                  <span className="num">
                    {usd(peakRisk)} / {usd(limits.maxRisk)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-line">
                  <div className={clsx('h-full rounded-full', riskPct >= 95 ? 'bg-warn' : 'bg-accent')} style={{ width: `${riskPct}%` }} />
                </div>
                {last && last.openRisk < 0 && <div className="mt-1 text-[10px] text-up">Final stop locks in {usd(-last.openRisk)}.</div>}
              </div>

              {plan.warnings.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {plan.warnings.map((w, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-warn">
                      <AlertTriangle className="mt-px size-3.5 shrink-0" />
                      {w.text}
                    </li>
                  ))}
                </ul>
              )}

              {plan.hotkeys && last && (
                <div className="grid grid-cols-1 gap-2 @[420px]:grid-cols-3">
                  {[
                    { label: 'Whole-position stop', value: last.stop, note: 'after the last planned lot' },
                    { label: 'DAS cover stop-limit', value: plan.hotkeys.coverStop, note: `avg cost + ${usd(limits.hotkeyOffset)}` },
                    { label: 'DAS long exit (mirror)', value: plan.hotkeys.longExit, note: `avg cost − ${usd(limits.hotkeyOffset)}` },
                  ].map((h) => (
                    <div key={h.label} className="rounded-lg border border-line bg-raised/60 px-3 py-2">
                      <div className="text-[10px] font-semibold tracking-wider text-muted uppercase">{h.label}</div>
                      <div className="num mt-0.5 text-[16px] font-semibold text-fg">{fmtPrice(h.value)}</div>
                      <div className="text-[10px] text-muted">{h.note}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <p className="text-[10px] leading-relaxed text-muted">
            A planning tool only. DeltaScan doesn't see your DAS positions or send orders; it sizes the plan from the prices you enter.
          </p>
        </div>
      </div>
    </div>
  );
}
