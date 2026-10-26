import { useEffect, useState, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import type { DilutionReport, RiskLevel, SymbolSnapshot } from '@deltascan/shared';
import { ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { marketData, type DilutionResult } from '../lib/marketData';
import { fmtCompact, fmtPct, fmtPrice, signClass } from '../lib/format';
import { addDilutionWindow } from '../lib/layout';
import { useUiStore } from '../store/uiStore';

export interface QuotePanelParams {
  /** Pinned symbol (double-click opens one per symbol); falls back to the selection. */
  symbol?: string | null;
}

const MONTH_MS = 30.44 * 86_400_000;
/** Rule 201: a 10% drop from the prior close turns on the short-sale restriction. */
const SSR_DROP = 0.9;

const RATING_STYLE: Record<RiskLevel, string> = {
  low: 'bg-up/15 text-up ring-up/30',
  medium: 'bg-warn/15 text-warn ring-warn/30',
  high: 'bg-down/15 text-down ring-down/30',
};
const RATINGS: { key: keyof DilutionReport['ratings'] | 'overall'; label: string }[] = [
  { key: 'overall', label: 'Overall Risk' },
  { key: 'offering', label: 'Offering' },
  { key: 'dilution', label: 'Dilution' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'cashNeed', label: 'Cash Need' },
  { key: 'warrants', label: 'Warrants' },
];

const usd = (n: number) => `${n < 0 ? '-' : ''}$${fmtCompact(Math.abs(n))}`;
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const etStamp = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

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

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Stat({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div title={title}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num text-[17px] leading-tight font-semibold text-fg">{children}</div>
    </div>
  );
}

const Na = () => <span className="text-muted">N/A</span>;
const YesNo = ({ yes }: { yes: boolean }) => <span className={yes ? 'text-down' : 'text-up'}>{yes ? 'Yes' : 'No'}</span>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-3">
      <h3 className="mb-1.5 text-[15px] font-semibold text-accent">{title}</h3>
      {children}
    </section>
  );
}

export function QuotePanel({ params, api: panelApi }: IDockviewPanelProps<QuotePanelParams>) {
  const selected = useUiStore((s) => s.selectedSymbol);
  const simulated = useUiStore((s) => s.provider?.provider === 'mock');
  const symbol = params.symbol ?? selected ?? null;
  const row = useLiveRow(symbol);
  const now = useNow(1_000);
  const [sec, setSec] = useState<DilutionResult | 'loading' | null>(null);

  useEffect(() => {
    panelApi.setTitle(symbol ? `${symbol} · Quote` : 'Quote');
    if (!symbol) return setSec(null);
    let cancelled = false;
    setSec('loading');
    void marketData.fetchDilution(symbol).then((r) => !cancelled && setSec(r));
    return () => {
      cancelled = true;
    };
  }, [panelApi, symbol]);

  if (!symbol) {
    return <div className="grid h-full place-items-center bg-panel text-[12px] text-muted">Double-click a symbol in any scanner.</div>;
  }

  const report = sec !== 'loading' && sec?.ok ? sec.report : null;
  const price = row?.last ?? null;
  const shares = report?.sharesOutstanding?.value ?? null;
  const marketCap = price !== null && shares !== null ? price * shares : row?.marketCap ?? null;
  const ssr = row?.low != null && row.prevClose != null && row.low <= row.prevClose * SSR_DROP;
  const location = report?.location ? (/^[A-Z]{2}$/.test(report.location) ? 'U.S.' : report.location) : null;

  // Cash carried forward from the last balance sheet at the reported burn rate.
  let estCash: number | null = null;
  let cashLeft: ReactNode = <Na />;
  if (report?.cashFlowPositive) {
    estCash = report.cash?.value ?? null;
    cashLeft = <span className="text-up">Cash-flow +</span>;
  } else if (report?.cash && report.monthlyBurn) {
    const elapsed = (now - Date.parse(`${report.cash.asOf}T00:00:00Z`)) / MONTH_MS;
    estCash = Math.max(0, report.cash.value - report.monthlyBurn * elapsed);
    const months = estCash / report.monthlyBurn;
    cashLeft = <span className={months < 6 ? 'text-down' : undefined}>{months.toFixed(1)} months</span>;
  }
  const splits = report?.filings.filter((f) => f.kind === 'reverse-split') ?? [];

  let ratingsNote: string | null = null;
  if (sec === 'loading') ratingsNote = 'Loading SEC filings…';
  else if (sec && !sec.ok) {
    ratingsNote =
      sec.reason === 'setup'
        ? 'SEC data is off: set SEC_USER_AGENT in .env and restart the server.'
        : sec.reason === 'not-found'
          ? simulated
            ? `${symbol} is a simulated ticker, so it has no SEC filings.`
            : sec.message
          : `Couldn't load SEC data: ${sec.message}.`;
  }

  return (
    <div className="h-full overflow-y-auto bg-panel">
      <div className="flex flex-col gap-3 p-4">
        <header>
          <h2 className="text-[24px] leading-tight font-bold text-fg">
            {symbol}
            {price !== null && <span className="num font-semibold"> - ${fmtPrice(price)}</span>}
            {row?.changePct != null && <span className={clsx('num ml-2 font-semibold', signClass(row.changePct))}>({fmtPct(row.changePct)})</span>}
          </h2>
          <div className="text-[15px] text-dim">{report?.name ?? row?.name ?? ' '}</div>
          {(report?.exchange || location) && (
            <div className="mt-1 text-[14px] text-dim">{[report?.exchange, location].filter(Boolean).join('  •  ')}</div>
          )}
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[14px] text-dim">
            <span>
              Foreign filer: {report ? <YesNo yes={report.foreignFiler} /> : <Na />}
            </span>
            <span title="Rule 201 short-sale restriction: on once the low is 10% below the prior close. Carry-over from yesterday isn't tracked yet.">
              SSR: {row?.prevClose != null ? <YesNo yes={ssr} /> : <Na />}
            </span>
          </div>
          {(report?.industry || row?.sector) && <p className="mt-1 text-[12px] text-muted">{report?.industry ?? row?.sector}</p>}
        </header>

        <section className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-line pt-3">
          <Stat label="Prev Close">{row?.prevClose != null ? `$${fmtPrice(row.prevClose)}` : <Na />}</Stat>
          <Stat label="Market Cap" title={simulated ? 'Uses the simulated price' : undefined}>
            {marketCap !== null ? usd(marketCap) : <Na />}
          </Stat>
          <Stat label="Float">{row?.floatShares != null ? fmtCompact(row.floatShares) : <Na />}</Stat>
          <Stat label="OS" title={report?.sharesOutstanding ? `SEC, as of ${shortDate(report.sharesOutstanding.asOf)}` : undefined}>
            {shares !== null ? fmtCompact(shares) : <Na />}
          </Stat>
          <Stat label="Inst. Own" title="Needs a holdings data provider">
            <Na />
          </Stat>
          <Stat label="Insider Own" title="Needs a holdings data provider">
            <Na />
          </Stat>
          <Stat label="Short Interest">{row?.shortInterestPct != null ? `${row.shortInterestPct.toFixed(1)}%` : <Na />}</Stat>
          <Stat label="Vol Avg.">{row?.avgVolume != null ? fmtCompact(row.avgVolume) : <Na />}</Stat>
        </section>

        <Section title="Dilution & Risk Ratings">
          {ratingsNote ? (
            <p className="text-[12px] text-muted">{ratingsNote}</p>
          ) : (
            report && (
              <div className="grid grid-cols-3 gap-x-2 gap-y-2">
                {RATINGS.map((r) => {
                  const value = r.key === 'overall' ? report.risk.level : report.ratings[r.key];
                  return (
                    <div key={r.key}>
                      <div className="text-[11px] text-muted">{r.label}</div>
                      <span
                        className={clsx(
                          'mt-0.5 inline-block rounded px-2 py-px text-[12px] font-semibold capitalize ring-1 ring-inset',
                          value ? RATING_STYLE[value] : 'bg-line text-muted ring-line',
                        )}
                      >
                        {value ?? 'N/A'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </Section>

        <section className="grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-line pt-3">
          <Stat label="Cash Left">{cashLeft}</Stat>
          <Stat label="Burn Rate" title={report?.burnPeriod ? `Average per month, ${shortDate(report.burnPeriod.start)} – ${shortDate(report.burnPeriod.end)}` : undefined}>
            {report?.monthlyBurn ? <span className="text-down">-{usd(report.monthlyBurn)}/mo</span> : <Na />}
          </Stat>
          <Stat label="Est Cash" title={report?.cash ? `Estimated from the ${shortDate(report.cash.asOf)} balance sheet` : undefined}>
            {estCash !== null ? <span className="text-up">{usd(estCash)}</span> : <Na />}
          </Stat>
          <Stat label="Equity Sales Since" title="8-K item 3.02 filings since the last balance sheet: cash raised that isn't in Est Cash">
            {report ? report.equitySalesSinceBalanceSheet : <Na />}
          </Stat>
        </section>

        <Section title="Recent Splits">
          {report?.reverseSplitSuspected || splits.length ? (
            <ul className="flex flex-col gap-0.5 text-[12px] text-dim">
              {report?.reverseSplitSuspected && <li>Share count dropped sharply around {shortDate(report.reverseSplitSuspected)} (likely a reverse split)</li>}
              {splits.map((f) => (
                <li key={f.url}>
                  <a href={f.url} target="_blank" rel="noreferrer" className="hover:text-accent">
                    {shortDate(f.filed)}: charter amendment (often a reverse split)
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-muted">{report ? 'No recent splits found.' : 'Needs SEC data.'}</p>
          )}
        </Section>

        <footer className="flex items-center justify-between gap-2 border-t border-line pt-3">
          {report ? (
            <button
              type="button"
              onClick={() => addDilutionWindow({ symbol, linked: false })}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-accent hover:bg-hover"
            >
              <ShieldAlert className="size-3.5" />
              Full dilution report
            </button>
          ) : (
            <span />
          )}
          <span className="num text-[11px] text-muted">{etStamp.format(now).replace(',', '')} ET</span>
        </footer>
        <p className="text-[10px] leading-relaxed text-muted">
          Educational information only, not investment advice. Ratings are DeltaScan's own reading of SEC EDGAR filings and lag the latest
          ones.
        </p>
      </div>
    </div>
  );
}
