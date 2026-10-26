import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import type { DilutionFilingKind, DilutionReport, ReportedValue, ReverseSplit, SymbolSnapshot } from '@deltascan/shared';
import { ExternalLink, Link2, Link2Off, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { marketData, type DilutionResult, type ProfileResult } from '../lib/marketData';
import { CompanyDescription, CompanyFacts, NewsList, useCompanyProfile } from '../components/CompanyInfo';
import { RiskRatings } from '../components/RiskRatings';
import { TapeStrip } from '../components/TapeStrip';
import { capLabel, cashPosition, floatLabel, fmtOffering, type Tone } from '../lib/dilutionView';
import { fmtCompact, fmtPct, fmtPrice, signClass } from '../lib/format';
import { requestLayoutSave } from '../lib/layout';
import { useUiStore } from '../store/uiStore';

export interface DilutionPanelParams {
  symbol?: string | null;
  linked?: boolean;
}

const FILINGS_SHOWN = 8;
const SHARE_COUNTS_SHOWN = 6;
const TONE: Record<Tone, string> = { up: 'text-up', down: 'text-down', warn: 'text-warn', dim: 'text-dim' };
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

type TimelineRow = { kind: 'count'; asOf: string; value: number; adjusted: number; changePct: number | null } | { kind: 'split'; split: ReverseSplit };

/** Recent share counts, oldest first, with reverse splits slotted in by date. */
function shareTimeline(report: DilutionReport): TimelineRow[] {
  const counts = report.shareHistory.slice(-SHARE_COUNTS_SHOWN);
  const first = counts[0]?.asOf ?? '';
  const rows: TimelineRow[] = counts.map((c, i) => ({
    kind: 'count',
    ...c,
    changePct: i > 0 ? (c.adjusted / counts[i - 1]!.adjusted - 1) * 100 : null,
  }));
  for (const split of report.reverseSplits) {
    if (split.date < first) continue;
    const at = rows.findIndex((r) => r.kind === 'count' && r.asOf >= split.date);
    rows.splice(at === -1 ? rows.length : at, 0, { kind: 'split', split });
  }
  return rows;
}

function SplitRow({ split }: { split: ReverseSplit }) {
  const title = split.ratio ? `${split.source === 'share-count' ? '≈ ' : ''}1-for-${split.ratio} reverse split` : 'Reverse split';
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-y border-violet/20 bg-violet/5 px-4 py-1.5 text-[11px]">
      <span className="num w-24 shrink-0 text-muted">{shortDate(split.date)}</span>
      <span className="font-semibold text-violet">{title}</span>
      {split.sharesAfter !== null && <span className="num text-dim">≈ {split.sharesAfter.toLocaleString()} shares after</span>}
      {split.url ? (
        <a href={split.url} target="_blank" rel="noreferrer" className="ml-auto text-[10px] text-muted hover:text-accent">
          8-K
        </a>
      ) : (
        <span className="ml-auto text-[10px] text-muted" title="No 8-K found; the ratio is estimated from the drop in share count">
          from share counts
        </span>
      )}
    </li>
  );
}

function Report({
  report,
  row,
  simulated,
  profile,
}: {
  report: DilutionReport;
  row: SymbolSnapshot | null;
  simulated: boolean;
  profile: ProfileResult | 'loading' | null;
}) {
  const companyProfile = profile !== 'loading' && profile?.ok ? profile.profile : null;
  const [showAll, setShowAll] = useState(false);
  const level = LEVEL[report.risk.level];
  const price = row?.last ?? null;
  const shares = report.sharesOutstanding?.value ?? null;
  const marketCap = price !== null && shares !== null ? price * shares : null;
  const monthsSinceCash = report.cash ? (Date.now() - Date.parse(`${report.cash.asOf}T00:00:00Z`)) / MONTH_MS : 0;
  const filings = showAll ? report.filings : report.filings.slice(0, FILINGS_SHOWN);
  const cashPos = cashPosition(report);
  const floatTag = floatLabel(row?.floatShares);
  const timeline = shareTimeline(report);

  let runway: ReactNode = '—';
  let runwayNote: ReactNode = 'No recent cash-flow figures';
  if (report.financial) runwayNote = 'Not meaningful for banks and lenders';
  else if (report.cashFlowPositive) {
    runway = 'Positive';
    runwayNote = 'Operating cash flow is positive';
  } else if (report.runwayMonths !== null) {
    runway = Math.max(0, report.runwayMonths - monthsSinceCash).toFixed(1);
    runwayNote = `left today · ${report.runwayMonths.toFixed(1)} at the ${shortDate(report.cash!.asOf)} balance sheet`;
  }

  return (
    <div className="@container flex flex-col gap-3 p-3">
      <section className="rounded-xl border border-line bg-raised/40 px-4 py-3">
        <div className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
          {[report.exchange, report.name].filter(Boolean).join(' · ')}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[28px] leading-none font-bold tracking-tight text-fg">${report.symbol}</span>
          {/* Price and change are in the tape strip above when the symbol is streaming. */}
          {!row && price !== null && <span className="num text-[16px] font-semibold text-fg">{fmtPrice(price)}</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
          {[report.industry, report.location, `CIK ${Number(report.cik)}`].filter(Boolean).map((tag) => (
            <span key={tag} className="rounded-md bg-line px-1.5 py-0.5 text-dim">{tag}</span>
          ))}
        </div>
        <CompanyFacts profile={companyProfile} className="mt-2 text-[11px] text-dim" />
        <div className="mt-2">
          <CompanyDescription profile={companyProfile} loading={profile === 'loading'} />
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
        <RiskRatings report={report} price={price} className="mt-3 border-t border-line/60 pt-2.5" />
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

      {(cashPos || report.financial) && (
        <section className="rounded-xl border border-line bg-raised/40 px-4 py-3">
          <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-fg uppercase">Cash position</div>
          <p className="text-[12px] leading-relaxed text-dim">
            {!cashPos ? (
              'Not meaningful for banks and lenders: their operating cash flow includes loans made.'
            ) : cashPos.positive ? (
              <>
                Operating cash flow is <span className="font-semibold text-up">positive</span>, so the company isn't burning cash
                {cashPos.estCash !== null && <> (last reported cash {usd(cashPos.estCash)})</>}.
              </>
            ) : (
              <>
                The company has about{' '}
                <span className={clsx('num font-semibold', cashPos.monthsLeft < 6 ? 'text-down' : cashPos.monthsLeft < 12 ? 'text-warn' : 'text-up')}>
                  {cashPos.monthsLeft.toFixed(1)} months
                </span>{' '}
                of cash left, based on a quarterly cash burn of <span className="num font-semibold text-fg">{usd(cashPos.quarterlyBurn)}</span> and
                estimated current cash of <span className="num font-semibold text-fg">{usd(cashPos.estCash)}</span>.
                {report.equitySalesSinceBalanceSheet > 0 && (
                  <>
                    {' '}
                    {report.equitySalesSinceBalanceSheet} equity sale{report.equitySalesSinceBalanceSheet > 1 ? 's' : ''} since the{' '}
                    {shortDate(report.cash!.asOf)} balance sheet {report.equitySalesSinceBalanceSheet > 1 ? "aren't" : "isn't"} included.
                  </>
                )}
              </>
            )}
          </p>
        </section>
      )}

      <section>
        <div className="mb-1.5 text-[10px] font-semibold tracking-[0.14em] text-accent uppercase">At a glance</div>
        <div className="grid grid-cols-1 gap-2 @[420px]:grid-cols-2 @[640px]:grid-cols-3">
          <Stat
            label="Market cap"
            value={marketCap !== null ? usd(marketCap) : '—'}
            note={
              price === null ? (
                'Not in the live stream, so no price'
              ) : (
                <>
                  <span className="font-semibold text-dim">{capLabel(marketCap)}</span> ·{' '}
                  {simulated ? 'uses the simulated price, not the real market cap' : 'live price × shares outstanding'}
                </>
              )
            }
          />
          <Stat
            label="Float"
            value={row?.floatShares != null ? fmtCompact(row.floatShares) : '—'}
            tone={floatTag?.tone === 'down' ? 'text-down' : undefined}
            note={floatTag ? <span className={clsx('font-semibold', TONE[floatTag.tone])}>{floatTag.text}</span> : 'Not in the live stream'}
          />
          <Stat label="Shares outstanding" value={shares !== null ? fmtCompact(shares) : '—'} note={asOf(report.sharesOutstanding)} />
          <Stat
            label="Share growth"
            value={report.shareGrowthPct !== null ? fmtPct(report.shareGrowthPct, 0) : '—'}
            tone={report.shareGrowthPct !== null && report.shareGrowthPct > 20 ? 'text-down' : undefined}
            note={
              report.shareGrowthSince
                ? `since ${shortDate(report.shareGrowthSince)}${
                    report.shareGrowthSplitAdjusted ? ', split-adjusted' : report.reverseSplitSuspected ? ' (after a likely reverse split)' : ''
                  }`
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

      {timeline.length > 0 && (
        <section className="rounded-xl border border-line bg-raised/40">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line px-4 py-2.5">
            <span className="text-[11px] font-semibold tracking-[0.12em] text-fg uppercase">Shares outstanding &amp; splits</span>
            {report.shareGrowthPct !== null && report.shareGrowthSince && (
              <span className="text-[11px] text-dim">
                <span className={clsx('num font-semibold', report.shareGrowthPct > 20 ? 'text-down' : 'text-fg')}>{fmtPct(report.shareGrowthPct, 0)}</span>{' '}
                since {shortDate(report.shareGrowthSince)}
                {report.shareGrowthSplitAdjusted && ', adjusted for the split'}
              </span>
            )}
          </div>
          <ul className="py-1">
            {timeline.map((r) =>
              r.kind === 'split' ? (
                <SplitRow key={`split-${r.split.date}`} split={r.split} />
              ) : (
                <li key={r.asOf} className="flex items-baseline gap-2 px-4 py-1 text-[11px]">
                  <span className="num w-24 shrink-0 text-muted">{shortDate(r.asOf)}</span>
                  <span className="num font-semibold text-fg">{r.value.toLocaleString()}</span>
                  {Math.round(r.adjusted) !== r.value && (
                    <span className="num text-muted" title="Restated for the later reverse split">
                      ({Math.round(r.adjusted).toLocaleString()} split-adj.)
                    </span>
                  )}
                  {r.changePct !== null && Math.abs(r.changePct) >= 0.5 && (
                    <span className={clsx('num ml-auto', r.changePct > 0 ? 'text-down' : 'text-up')}>{fmtPct(r.changePct, 0)}</span>
                  )}
                </li>
              ),
            )}
          </ul>
          {report.reverseSplits.length === 0 && <p className="border-t border-line/60 px-4 py-1.5 text-[10px] text-muted">No reverse splits in the last two years.</p>}
        </section>
      )}

      <section className="rounded-xl border border-line bg-raised/40 px-4 py-2.5">
        <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-fg uppercase">Latest news</div>
        <NewsList result={profile} />
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
                {f.amount && fmtOffering(f.amount) && (
                  <span className={clsx('num shrink-0 text-[11px] font-semibold', f.amount.resale ? 'text-muted' : 'text-down')}>{fmtOffering(f.amount)}</span>
                )}
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
        data, the filing index and filing text, fetched {new Date(report.fetchedAt).toLocaleTimeString()}. They lag the latest filings, share
        counts are adjusted only for reverse splits announced in 8-Ks, offering sizes are read from prospectus text, and the ratings are
        DeltaScan's own heuristics. Check the filings themselves before acting.
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
  const profile = useCompanyProfile(symbol);
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
        {row && (
          <div className="px-3 pt-3">
            <TapeStrip
              row={row}
              country={profile !== 'loading' && profile?.ok ? profile.profile.country : null}
              sector={row.sector ?? (result !== 'loading' && result?.ok ? result.report.industry : null)}
            />
          </div>
        )}
        {body !== null ? (
          <div className={clsx('grid place-items-center p-6', !row && 'h-full')}>
            <div className="flex max-w-sm flex-col items-center gap-2 text-center text-[12px] leading-relaxed text-muted">
              <ShieldAlert className="size-6 text-muted/60" />
              <div>{body}</div>
            </div>
          </div>
        ) : (
          result !== 'loading' && result?.ok && <Report key={result.report.symbol} report={result.report} row={row} simulated={simulated} profile={profile} />
        )}
      </div>
    </div>
  );
}
