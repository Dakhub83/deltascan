import type { DilutionFiling, DilutionFilingKind, DilutionReport, ReportedValue, RiskLevel, RiskReason } from '@deltascan/shared';

/** The parts of SEC's companyfacts JSON we read. Dimensional facts aren't included in it. */
export interface CompanyFacts {
  facts: Record<string, Record<string, { units: Record<string, FactPoint[]> }>>;
}

export interface FactPoint {
  start?: string;
  end: string;
  val: number;
  accn: string;
  form: string;
  filed: string;
}

/** The parts of SEC's submissions JSON we read. `filings.recent` arrays are parallel, newest first. */
export interface Submissions {
  name: string;
  sic?: string;
  exchanges?: string[];
  sicDescription?: string;
  addresses?: Partial<Record<'business' | 'mailing', { stateOrCountry?: string | null; stateOrCountryDescription?: string | null }>>;
  stateOfIncorporation?: string;
  stateOfIncorporationDescription?: string;
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      /** ISO timestamp the filing was accepted; more precise than filingDate. */
      acceptanceDateTime?: string[];
      items: string[];
      accessionNumber: string[];
      primaryDocument: string[];
    };
  };
}

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.44;
/** Balance-sheet items older than this are too stale to show. */
const STALE_DAYS = 18 * 30;
/** A cover-page share count falling by more than this is almost always a reverse split. */
const REVERSE_SPLIT_DROP = 0.4;

const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const daysBetween = (a: string, b: number) => (b - time(a)) / DAY_MS;

function points(facts: CompanyFacts, ns: string, tag: string, unit: string): FactPoint[] {
  return facts.facts[ns]?.[tag]?.units[unit] ?? [];
}

/** Later filings restate earlier periods; keep the most recently filed value for each period end. */
function byPeriodEnd(pts: FactPoint[]): FactPoint[] {
  const latest = new Map<string, FactPoint>();
  for (const p of pts) {
    const cur = latest.get(p.end);
    if (!cur || p.filed > cur.filed) latest.set(p.end, p);
  }
  return [...latest.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** The latest value across `tags`, preferring earlier tags when period ends tie. */
function latestOf(facts: CompanyFacts, tags: string[], unit: string, now: number): ReportedValue | null {
  let best: FactPoint | null = null;
  for (const tag of tags) {
    const last = byPeriodEnd(points(facts, 'us-gaap', tag, unit)).at(-1);
    if (last && (!best || last.end > best.end)) best = last;
  }
  if (!best || daysBetween(best.end, now) > STALE_DAYS) return null;
  return toReported(best);
}

const toReported = (p: FactPoint): ReportedValue => ({ value: p.val, asOf: p.end, form: p.form, filed: p.filed });

/** Cover-page share counts. Multi-class issuers report one value per class in the same filing, so those are summed. */
function shareHistory(facts: CompanyFacts): FactPoint[] {
  let pts = points(facts, 'dei', 'EntityCommonStockSharesOutstanding', 'shares');
  if (!pts.length) pts = points(facts, 'us-gaap', 'CommonStockSharesOutstanding', 'shares');
  const perFiling = new Map<string, FactPoint>();
  for (const p of pts) {
    const key = `${p.accn}|${p.end}`;
    const cur = perFiling.get(key);
    perFiling.set(key, cur ? { ...cur, val: cur.val + p.val } : { ...p });
  }
  return byPeriodEnd([...perFiling.values()]);
}

function shareGrowth(history: FactPoint[], now: number) {
  const latest = history.at(-1);
  if (!latest || history.length < 2) return { pct: null, since: null, reverseSplit: null };
  let reverseSplit: string | null = null;
  let baseIndex = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.val < history[i - 1]!.val * (1 - REVERSE_SPLIT_DROP)) {
      baseIndex = i;
      reverseSplit = history[i]!.end;
    }
  }
  // Compare with the count about a year ago, but never across a reverse split.
  const yearAgo = history.findLastIndex((p) => daysBetween(p.end, now) >= 365);
  baseIndex = Math.max(baseIndex, yearAgo);
  const base = history[baseIndex]!;
  if (base === latest) return { pct: null, since: null, reverseSplit };
  const recentSplit = reverseSplit && daysBetween(reverseSplit, now) <= 2 * 365 ? reverseSplit : null;
  return { pct: (latest.val / base.val - 1) * 100, since: base.end, reverseSplit: recentSplit };
}

function burn(facts: CompanyFacts) {
  const ocf = points(facts, 'us-gaap', 'NetCashProvidedByUsedInOperatingActivities', 'USD').filter((p) => p.start);
  // Latest period end; for ties (e.g. a 10-K's year vs. quarter), the most recent filing.
  const last = ocf.reduce<FactPoint | null>((best, p) => (!best || p.end > best.end || (p.end === best.end && p.filed > best.filed) ? p : best), null);
  if (!last) return null;
  const months = Math.max(1, (time(last.end) - time(last.start!)) / DAY_MS / MONTH_DAYS);
  return { monthly: -last.val / months, start: last.start!, end: last.end };
}

/** Convertible debt: a total tag if reported, otherwise current + noncurrent, all at the latest period end. */
function convertibleDebt(facts: CompanyFacts, now: number): ReportedValue | null {
  const totals = ['ConvertibleNotesPayable', 'ConvertibleDebt'];
  const parts = ['ConvertibleNotesPayableCurrent', 'ConvertibleDebtCurrent', 'ConvertibleDebtNoncurrent', 'ConvertibleLongTermNotesPayable'];
  const lastOf = (tag: string) => byPeriodEnd(points(facts, 'us-gaap', tag, 'USD')).at(-1);
  const all = [...totals, ...parts].map(lastOf).filter((p): p is FactPoint => !!p);
  if (!all.length) return null;
  const end = all.reduce((m, p) => (p.end > m ? p.end : m), '');
  if (daysBetween(end, now) > STALE_DAYS) return null;
  const total = totals.map(lastOf).find((p) => p?.end === end);
  if (total) return total.val > 0 ? toReported(total) : null;
  const atEnd = parts.map(lastOf).filter((p): p is FactPoint => p?.end === end);
  const sum = atEnd.reduce((s, p) => s + p.val, 0);
  return sum > 0 ? { ...toReported(atEnd[0]!), value: sum } : null;
}

const REGISTRATIONS = /^(S-1|F-1|S-3|F-3|S-3ASR)(\/A)?$/;
const PROSPECTUS = /^424B[1-8]$/;

/** 8-K items that matter for dilution, most significant first. */
const EIGHT_K_ITEMS: { item: string; kind: DilutionFilingKind; label: string }[] = [
  { item: '3.01', kind: 'delisting', label: 'Listing deficiency or delisting notice' },
  { item: '3.02', kind: 'equity-sale', label: 'Unregistered sale of equity' },
  { item: '5.03', kind: 'reverse-split', label: 'Charter amendment (often a reverse split)' },
  { item: '1.01', kind: 'agreement', label: 'Material agreement (often a financing)' },
];

function classify(form: string, items: string): { kind: DilutionFilingKind; label: string } | null {
  if (REGISTRATIONS.test(form)) {
    return form.startsWith('S-3') || form.startsWith('F-3')
      ? { kind: 'registration', label: 'Shelf registration (lets the company sell shares later)' }
      : { kind: 'registration', label: 'Registration statement (offering or resale)' };
  }
  if (PROSPECTUS.test(form)) {
    return form === '424B5'
      ? { kind: 'offering', label: 'Prospectus supplement (shelf takedown or ATM)' }
      : { kind: 'offering', label: 'Prospectus (offering or resale)' };
  }
  if (form === 'EFFECT') return { kind: 'effective', label: 'Registration declared effective (shares can now be sold)' };
  if (form === 'S-8' || form === 'S-8 POS') return { kind: 'comp-plan', label: 'Shares registered for a compensation plan' };
  if (/^NT (10-K|10-Q|20-F)/.test(form)) return { kind: 'late', label: 'Late filing notice' };
  if (form === '8-K' || form === '8-K/A') {
    const found = EIGHT_K_ITEMS.filter((e) => items.split(',').includes(e.item));
    if (found.length) return { kind: found[0]!.kind, label: found.map((f) => f.label).join(' · ') };
  }
  return null;
}

function recentFilings(subs: Submissions, cik: string, now: number): (DilutionFiling & { items: string })[] {
  const r = subs.filings.recent;
  const out: (DilutionFiling & { items: string })[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const filed = r.filingDate[i]!;
    if (daysBetween(filed, now) > 365) break;
    const c = classify(r.form[i]!, r.items[i] ?? '');
    if (!c) continue;
    const accn = r.accessionNumber[i]!.replaceAll('-', '');
    out.push({
      form: r.form[i]!,
      filed,
      items: r.items[i] ?? '',
      ...c,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn}/${r.primaryDocument[i]}`,
    });
  }
  return out;
}

const fmtM = (n: number) =>
  Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`;

/** SIC 6000–6799: banks, lenders, insurers. Their operating cash flow includes loans made, so "burn" isn't burn. */
const isFinancial = (sic: string | undefined) => sic !== undefined && Number(sic) >= 6000 && Number(sic) < 6800;

export function buildDilutionReport(symbol: string, cik: string, facts: CompanyFacts, subs: Submissions, now = Date.now()): DilutionReport {
  const history = shareHistory(facts);
  const latestShares = history.at(-1);
  const sharesOutstanding = latestShares && daysBetween(latestShares.end, now) <= STALE_DAYS ? toReported(latestShares) : null;
  const growth = shareGrowth(history, now);
  const cash = latestOf(facts, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'], 'USD', now);
  const financial = isFinancial(subs.sic);
  const b = financial ? null : burn(facts);
  const burnRecent = b && daysBetween(b.end, now) <= STALE_DAYS ? b : null;
  const cashFlowPositive = burnRecent !== null && burnRecent.monthly <= 0;
  const monthlyBurn = burnRecent && burnRecent.monthly > 0 ? burnRecent.monthly : null;
  const runwayMonths = cash && monthlyBurn ? cash.value / monthlyBurn : null;
  const warrants = latestOf(facts, ['ClassOfWarrantOrRightOutstanding'], 'shares', now);
  const preferred = latestOf(facts, ['PreferredStockSharesOutstanding'], 'shares', now);
  const preferredShares = preferred && preferred.value > 0 ? preferred : null;
  const convertible = convertibleDebt(facts, now);

  // Only well-known seasoned issuers (≥ $700M float) may file automatic shelves (S-3ASR). Their
  // prospectus filings are usually debt deals, so they don't count toward the score.
  const wellKnownIssuer = subs.filings.recent.form.includes('S-3ASR');
  const filings = recentFilings(subs, cik, now).map((f) =>
    wellKnownIssuer && (f.kind === 'offering' || f.kind === 'registration') ? { ...f, label: `${f.label} · large issuer, often debt` } : f,
  );
  const within = (days: number) => filings.filter((f) => daysBetween(f.filed, now) <= days);
  const equitySalesSinceBalanceSheet = cash
    ? filings.filter((f) => f.form.startsWith('8-K') && f.items.split(',').includes('3.02') && f.filed > cash.asOf).length
    : 0;

  const reasons: RiskReason[] = [];
  const add = (points: number, text: string) => points > 0 && reasons.push({ points, text });

  if (runwayMonths !== null && cash) {
    const left = runwayMonths - daysBetween(cash.asOf, now) / MONTH_DAYS;
    const runwayText = `${fmtM(cash.value)} cash at ${fmtM(monthlyBurn!)}/month burn`;
    if (left < 6) add(3, `Under 6 months of cash left (${runwayText}, as of ${cash.asOf})`);
    else if (left < 12) add(2, `Under 12 months of cash left (${runwayText})`);
    else if (left < 24) add(1, `Under 24 months of cash left (${runwayText})`);
  } else if (!cashFlowPositive && !financial) {
    add(1, 'No recent cash or cash-flow figures to judge runway');
  }

  const offerings = wellKnownIssuer
    ? []
    : within(182).filter((f) => f.kind === 'offering' || (f.kind === 'registration' && !f.form.startsWith('S-3') && !f.form.startsWith('F-3')));
  if (offerings.length) add(2, `${offerings.length} offering or resale filing${offerings.length > 1 ? 's' : ''} in the last 6 months`);
  if (within(182).some((f) => f.kind === 'effective')) add(1, 'A registration went effective in the last 6 months (registered shares can be sold)');
  if (!wellKnownIssuer && filings.some((f) => f.form.startsWith('S-3') || f.form.startsWith('F-3'))) add(1, 'Shelf registration filed in the last year');

  const equitySales = within(182).filter((f) => f.form.startsWith('8-K') && f.items.split(',').includes('3.02')).length;
  if (equitySales >= 3) add(2, `${equitySales} unregistered equity sales (8-K 3.02) in the last 6 months`);
  else if (equitySales > 0) add(1, `${equitySales} unregistered equity sale${equitySales > 1 ? 's' : ''} (8-K 3.02) in the last 6 months`);

  if (growth.pct !== null && growth.pct > 50) add(2, `Share count up ${Math.round(growth.pct)}% since ${growth.since}`);
  else if (growth.pct !== null && growth.pct > 20) add(1, `Share count up ${Math.round(growth.pct)}% since ${growth.since}`);
  if (growth.reverseSplit) add(1, `Share count dropped sharply around ${growth.reverseSplit} (likely a reverse split)`);

  if (warrants && sharesOutstanding && warrants.value >= sharesOutstanding.value * 0.1) {
    add(1, `Warrants equal to ${Math.round((warrants.value / sharesOutstanding.value) * 100)}% of shares outstanding`);
  }
  if (convertible) add(1, `${fmtM(convertible.value)} of convertible debt (can convert into shares)`);
  if (filings.some((f) => f.kind === 'delisting')) add(1, 'Listing deficiency or delisting notice in the last year');
  if (filings.some((f) => f.kind === 'late')) add(1, 'Filed a late-filing notice in the last year');

  reasons.sort((a, b) => b.points - a.points);
  const score = Math.min(10, reasons.reduce((s, r) => s + r.points, 0));

  const level = (value: number, medium: number, high: number): RiskLevel => (value >= high ? 'high' : value >= medium ? 'medium' : 'low');
  const offeringsYear = wellKnownIssuer ? [] : filings.filter((f) => f.kind === 'offering' || f.kind === 'effective');
  const dilutiveEvents = offeringsYear.length + filings.filter((f) => f.kind === 'equity-sale').length;
  const remainingRunway = runwayMonths !== null && cash ? runwayMonths - daysBetween(cash.asOf, now) / MONTH_DAYS : null;
  const ratings: DilutionReport['ratings'] = {
    offering:
      offerings.length >= 2 || within(182).some((f) => f.kind === 'effective')
        ? 'high'
        : offeringsYear.length || (!wellKnownIssuer && filings.some((f) => f.form.startsWith('S-3') || f.form.startsWith('F-3')))
          ? 'medium'
          : 'low',
    dilution: growth.pct === null ? null : level(growth.pct, 20, 50),
    frequency: level(dilutiveEvents, 2, 6),
    cashNeed: financial ? null : cashFlowPositive ? 'low' : remainingRunway === null ? null : remainingRunway < 6 ? 'high' : remainingRunway < 12 ? 'medium' : 'low',
    warrants: !warrants ? 'low' : sharesOutstanding ? level(warrants.value / sharesOutstanding.value, 0.05, 0.2) : null,
  };
  const foreignFiler = subs.filings.recent.form.some((f) => /^(20-F|40-F|6-K)/.test(f));

  return {
    symbol,
    cik,
    name: subs.name,
    exchange: subs.exchanges?.[0] ?? null,
    industry: subs.sicDescription || null,
    location: subs.addresses?.business?.stateOrCountryDescription ?? null,
    sharesOutstanding,
    shareHistory: history.slice(-12).map((p) => ({ asOf: p.end, value: p.val })),
    shareGrowthPct: growth.pct,
    shareGrowthSince: growth.since,
    reverseSplitSuspected: growth.reverseSplit,
    cash,
    monthlyBurn,
    burnPeriod: burnRecent ? { start: burnRecent.start, end: burnRecent.end } : null,
    cashFlowPositive,
    runwayMonths,
    financial,
    warrants,
    preferredShares,
    convertibleDebt: convertible,
    filings: filings.map(({ items: _items, ...f }) => f),
    equitySalesSinceBalanceSheet,
    risk: { score, level: score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low', reasons },
    ratings,
    foreignFiler,
    fetchedAt: now,
  };
}
