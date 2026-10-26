import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import type { DilutionFilingKind, DilutionReport, ReportedValue, SymbolSnapshot } from '@deltascan/shared';
import { ExternalLink, Link2, Link2Off, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { marketData, type DilutionResult } from '../lib/marketData';
import { fmtCompact, fmtPct, fmtPrice, signClass } from '../lib/format';
import { requestLayoutSave } from '../lib/layout';
import { useUiStore } from '../store/uiStore';

export interface DilutionPanelParams {
  symbol?: string | null;
  linked?: boolean;
}

const FILINGS_SHOWN = 8;
const MONTH_MS = 30.44 * 86_400_000;

const LEVEL = {
  low: { label: 'LOW', text: 'text-up', bar: 'bg-up', card: 'border-up/25 bg-up/5' },
  medium: { label: 'MEDIUM', text: 'text-warn', bar: 'bg-warn', card: 'border-warn/30 bg-warn/5' },
  high: { label: 'HIGH', text: 'text-down', bar: 'bg-down', card: 'border-down/30 bg-down/5' },
} as const;

const KIND_STYLE: Record<DilutionFilingKind, string> = {
  offering: 'bg-down/12 text-down ring-down/25',
  registration: 'bg-warn/12 text-warn ring-warn/25',
  effective: 'bg-warn/12 text-warn ring-warn/25',
  'equity-sale': 'bg-down/12 text-down ring-down/25',
  agreement: 'bg-accent/12 text-accent ring-accent/25',
  'reverse-split': 'bg-violet/12 text-violet ring-violet/25',
  delisting: 'bg-down/12 text-down ring-down/25',
  late: 'bg-violet/12 text-violet ring-violet/25',
  'comp-plan': 'bg-line text-dim ring-line-strong',
};

const usd = (n: number) => `$${fmtCompact(n)}`;
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const asOf = (v: ReportedValue | null) => (v ? `as of ${shortDate(v.asOf)} · ${v.form}` : undefined);

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

function Stat({ label, value, unit, note, tone }: { label: string; value: ReactNode; unit?: string; note?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-raised/60 px-3 py-2.5">
      <div className="text-[10px] font-semibold tracking-wider text-muted uppercase">{label}</div>
      <div className={clsx('num mt-1 text-[18px] font-semibold', tone ?? 'text-fg')}>
        {value}
        {unit && <span className="ml-1 text-[10px] font-medium text-muted">{unit}</span>}
      </div>
      {note && <div className="mt-0.5 text-[10px] leading-snug text-muted">{note}</div>}
    </div>
  );
}

function Report({ report, row, simulated }: { report: DilutionReport; row: SymbolSnapshot | null; simulated: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const level = LEVEL[report.risk.level];
  const price = row?.last ?? null;
  const shares = report.sharesOutstanding?.value ?? null;
  const marketCap = price !== null && shares !== null ? price * shares : null;
  const monthsSinceCash = report.cash ? (Date.now() - Date.parse(`${report.cash.asOf}T00:00:00Z`)) / MONTH_MS : 0;
  const filings = showAll ? report.filings : report.filings.slice(0, FILINGS_SHOWN);

  let runway: ReactNode = '—';
  let runwayNote: ReactNode = 'No recent cash-flow figures';
  if (report.financial) runwayNote = 'Not meaningful for banks and lenders';
  else if (report.cashFlowPositive) {
    runway = 'Positive';
    runwayNote = 'Operating cash flow is positive';
  } else if (report.runwayMonths !== null) {
    runway = report.runwayMonths.toFixed(1);
    runwayNote = `at ${shortDate(report.cash!.asOf)} · ${monthsSinceCash.toFixed(1)} months have passed`;
  }

  return (
    <div className="@container flex flex-col gap-3 p-3">
      <section className="rounded-xl border border-line bg-raised/40 px-4 py-3">
        <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
          {[report.exchange, report.name].filter(Boolean).join(' · ')}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[28px] leading-none font-bold tracking-tight text-fg">${report.symbol}</span>
          {price !== null && <span className="num text-[16px] font-semibold text-fg">{fmtPrice(price)}</span>}
          {row?.changePct != null && <span className={clsx('num text-[14px] font-semibold', signClass(row.changePct))}>{fmtPct(row.changePct, 1)}</span>}
          {row && <span className="num text-[11px] text-muted">Vol {fmtCompact(row.volume)}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
          {[report.industry, report.location, `CIK ${Number(report.cik)}`].filter(Boolean).map((tag) => (
            <span key={tag} className="rounded-md bg-line px-1.5 py-0.5 text-dim">{tag}</span>
          ))}
        </div>
      </section>

      <section className={clsx('rounded-xl border px-4 py-3', level.card)}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.14em] text-dim uppercase">Dilution risk</div>
            <div className={clsx('text-[18px] font-bold', level.text)}>{level.label}</div>
          </div>
          <div className="flex min-w-40 flex-1 gap-1" aria-label={`Score ${report.risk.score} of 10`}>
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={clsx('h-2 flex-1 rounded-full', i < report.risk.score ? level.bar : 'bg-line')} />
            ))}
          </div>
          <div className={clsx('num text-[14px] font-semibold', level.text)}>{report.risk.score} / 10</div>
        </div>
        {report.risk.reasons.length > 0 ? (
          <ul className="mt-2.5 flex flex-col gap-1">
            {report.risk.reasons.map((r) => (
              <li key={r.text} className="flex gap-2 text-[11px] leading-snug text-dim">
                <span className={clsx('num w-5 shrink-0 text-right font-semibold', level.text)}>+{r.points}</span>
                {r.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11px] text-dim">No dilution warning signs in the last year of SEC data.</p>
        )}
      </section>

      <section>
        <div className="mb-1.5 text-[10px] font-semibold tracking-[0.14em] text-accent uppercase">At a glance</div>
        <div className="grid grid-cols-1 gap-2 @[420px]:grid-cols-2 @[640px]:grid-cols-3">
          <Stat
            label="Market cap"
            value={marketCap !== null ? usd(marketCap) : '—'}
            note={
              price === null
                ? 'Not in the live stream, so no price'
                : simulated
                  ? 'Uses the simulated price; not the real market cap'
                  : 'Live price × shares outstanding'
            }
          />
          <Stat label="Shares outstanding" value={shares !== null ? fmtCompact(shares) : '—'} note={asOf(report.sharesOutstanding)} />
          <Stat
            label="Share growth"
            value={report.shareGrowthPct !== null ? fmtPct(report.shareGrowthPct, 0) : '—'}
            tone={report.shareGrowthPct !== null && report.shareGrowthPct > 20 ? 'text-down' : undefined}
            note={
              report.shareGrowthSince
                ? `since ${shortDate(report.shareGrowthSince)}${report.reverseSplitSuspected ? ' (after a likely reverse split)' : ''}`
                : 'Not enough history'
            }
          />
          <Stat
            label="Cash"
            value={report.cash ? usd(report.cash.value) : '—'}
            note={
              report.cash
                ? `${asOf(report.cash)}${report.equitySalesSinceBalanceSheet ? ` · ${report.equitySalesSinceBalanceSheet} equity sales since` : ''}`
                : undefined
            }
          />
          <Stat
            label="Monthly burn"
            value={report.monthlyBurn !== null ? usd(report.monthlyBurn) : '—'}
            note={report.burnPeriod ? `average, ${shortDate(report.burnPeriod.start)} – ${shortDate(report.burnPeriod.end)}` : undefined}
          />
          <Stat
            label="Cash runway"
            value={runway}
            unit={report.runwayMonths !== null && !report.cashFlowPositive ? 'months' : undefined}
            tone={report.runwayMonths !== null && report.runwayMonths - monthsSinceCash < 6 ? 'text-down' : undefined}
            note={runwayNote}
          />
          <Stat label="Warrants" value={report.warrants ? fmtCompact(report.warrants.value) : '—'} note={asOf(report.warrants) ?? 'None reported'} />
          <Stat
            label="Preferred shares"
            value={report.preferredShares ? fmtCompact(report.preferredShares.value) : '—'}
            note={asOf(report.preferredShares) ?? 'None reported'}
          />
          <Stat
            label="Convertible debt"
            value={report.convertibleDebt ? usd(report.convertibleDebt.value) : '—'}
            note={asOf(report.convertibleDebt) ?? 'None reported'}
          />
        </div>
      </section>

      <section className="rounded-xl border border-line bg-raised/40">
        <div className="flex items-baseline justify-between border-b border-line px-4 py-2.5">
          <span className="text-[11px] font-semibold tracking-[0.12em] text-fg uppercase">
            {report.filings.length} dilution-related filing{report.filings.length === 1 ? '' : 's'}
          </span>
          <span className="text-[10px] text-muted">last 12 months</span>
        </div>
        {report.filings.length === 0 && <p className="px-4 py-3 text-[11px] text-muted">None.</p>}
        <ul>
          {filings.map((f) => (
            <li key={f.url} className="border-b border-line/60 last:border-0">
              <a href={f.url} target="_blank" rel="noreferrer" className="group flex items-center gap-3 px-4 py-2 hover:bg-hover">
                <span className="num w-20 shrink-0 text-[11px] text-muted">{shortDate(f.filed)}</span>
                <span className={clsx('w-16 shrink-0 rounded px-1.5 py-px text-center text-[10px] font-semibold ring-1 ring-inset', KIND_STYLE[f.kind])}>{f.form}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-dim group-hover:text-fg">{f.label}</span>
                <ExternalLink className="size-3 shrink-0 text-muted opacity-0 group-hover:opacity-100" />
              </a>
            </li>
          ))}
        </ul>
        {report.filings.length > FILINGS_SHOWN && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="w-full border-t border-line py-1.5 text-[11px] text-accent hover:bg-hover">
            {showAll ? 'Show fewer' : `Show all ${report.filings.length}`}
          </button>
        )}
      </section>

      <footer className="rounded-lg border border-warn/20 bg-warn/5 px-3 py-2 text-[10px] leading-relaxed text-muted">
        <span className="font-semibold text-dim">Educational information only, not investment advice.</span> Figures come from SEC EDGAR XBRL
        data and the filing index, fetched {new Date(report.fetchedAt).toLocaleTimeString()}. They lag the latest filings, aren't adjusted for
        splits, and the risk score is DeltaScan's own heuristic. Check the filings themselves before acting.
      </footer>
    </div>
  );
}

export function DilutionPanel({ params, api: panelApi }: IDockviewPanelProps<DilutionPanelParams>) {
  const linked = params.linked ?? true;
  const selected = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const simulated = useUiStore((s) => s.provider?.provider === 'mock');
  const symbol = (linked ? selected : params.symbol) ?? null;
  const row = useLiveRow(symbol);
  const [result, setResult] = useState<DilutionResult | 'loading' | null>(null);
  const [draft, setDraft] = useState('');

  const update = (patch: Partial<DilutionPanelParams>) => {
    panelApi.updateParameters(patch);
    requestLayoutSave();
  };

  useEffect(() => {
    panelApi.setTitle(symbol ? `${symbol} · Dilution` : 'Dilution');
    if (!symbol) return setResult(null);
    let cancelled = false;
    setResult('loading');
    void marketData.fetchDilution(symbol).then((r) => !cancelled && setResult(r));
    return () => {
      cancelled = true;
    };
  }, [panelApi, symbol]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sym = draft.trim().toUpperCase();
    setDraft('');
    if (!sym) return;
    if (linked) setSelectedSymbol(sym);
    else update({ symbol: sym });
  };

  let body: ReactNode;
  if (!symbol) body = 'Select a symbol in any scanner, or type one above.';
  else if (result === 'loading' || result === null) body = `Loading SEC filings for ${symbol}…`;
  else if (result.ok) body = null;
  else if (result.reason === 'setup')
    body = (
      <>
        SEC data is off. Add <code className="rounded bg-line px-1 text-dim">SEC_USER_AGENT="DeltaScan you@example.com"</code> to{' '}
        <code className="rounded bg-line px-1 text-dim">.env</code> with your own email, then restart the server. SEC requires a contact on every request.
      </>
    );
  else if (result.reason === 'not-found')
    body = simulated ? `${symbol} is a simulated ticker, so SEC has no filings for it. Try a real one like AAPL or SOFI.` : result.message;
  else body = `Couldn't load SEC data: ${result.message}.`;

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <form onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={symbol ?? 'Symbol'}
            aria-label="Dilution symbol"
            maxLength={10}
            className="h-6 w-20 rounded-md border border-line bg-bg px-2 text-[12px] font-semibold text-fg uppercase outline-none placeholder:font-semibold placeholder:text-fg placeholder:normal-case focus:border-accent/60 focus:placeholder:text-muted"
          />
        </form>
        <button
          type="button"
          onClick={() => (linked ? update({ linked: false, symbol }) : update({ linked: true }))}
          title={linked ? 'Linked to the selected symbol. Click to pin this window to its symbol.' : 'Pinned. Click to follow the selected symbol.'}
          aria-label={linked ? 'Unlink from selection' : 'Link to selection'}
          className={clsx('grid size-6 place-items-center rounded-md transition-colors hover:bg-hover', linked ? 'text-accent' : 'text-muted hover:text-fg')}
        >
          {linked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}
        </button>
        <span className="ml-auto text-[10px] font-medium tracking-wider text-muted uppercase">SEC EDGAR</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {body !== null ? (
          <div className="grid h-full place-items-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center text-[12px] leading-relaxed text-muted">
              <ShieldAlert className="size-6 text-muted/60" />
              <div>{body}</div>
            </div>
          </div>
        ) : (
          result !== 'loading' && result?.ok && <Report key={result.report.symbol} report={result.report} row={row} simulated={simulated} />
        )}
      </div>
    </div>
  );
}
