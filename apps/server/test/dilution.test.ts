import { describe, expect, it } from 'vitest';
import { buildDilutionReport, type CompanyFacts, type FactPoint, type Submissions } from '../src/fundamentals/dilution';

const NOW = Date.parse('2026-10-25T12:00:00Z');

const pt = (end: string, val: number, extra: Partial<FactPoint> = {}): FactPoint => ({
  end,
  val,
  accn: `acc-${end}`,
  form: '10-Q',
  filed: end,
  ...extra,
});

function facts(over: { shares?: FactPoint[]; cash?: FactPoint[]; ocf?: FactPoint[]; warrants?: FactPoint[]; convertible?: FactPoint[] } = {}): CompanyFacts {
  return {
    facts: {
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: over.shares ?? [pt('2026-08-01', 10_000_000)] } } },
      'us-gaap': {
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: over.cash ?? [pt('2026-06-30', 1_200_000)] } },
        NetCashProvidedByUsedInOperatingActivities: {
          units: { USD: over.ocf ?? [pt('2026-06-30', -1_200_000, { start: '2026-01-01' })] },
        },
        ClassOfWarrantOrRightOutstanding: { units: { shares: over.warrants ?? [] } },
        ConvertibleNotesPayable: { units: { USD: over.convertible ?? [] } },
      },
    },
  };
}

function subs(filings: { form: string; filed: string; items?: string }[] = [], sic = '7372'): Submissions {
  return {
    name: 'Test Corp',
    sic,
    exchanges: ['Nasdaq'],
    sicDescription: 'Software',
    filings: {
      recent: {
        form: filings.map((f) => f.form),
        filingDate: filings.map((f) => f.filed),
        items: filings.map((f) => f.items ?? ''),
        accessionNumber: filings.map((_, i) => `0000000000-26-00000${i}`),
        primaryDocument: filings.map(() => 'doc.htm'),
      },
    },
  };
}

describe('buildDilutionReport', () => {
  it('derives monthly burn and runway from the latest year-to-date operating cash flow', () => {
    const r = buildDilutionReport('TST', '0000000001', facts(), subs(), NOW);
    expect(r.cash?.value).toBe(1_200_000);
    expect(r.monthlyBurn).toBeCloseTo(1_200_000 / (180 / 30.44), -2); // Jan 1 → Jun 30
    expect(r.runwayMonths).toBeCloseTo(5.9, 1);
    // ~4 months have passed since Jun 30, so under 6 months remain.
    expect(r.risk.reasons[0]).toMatchObject({ points: 3 });
  });

  it('measures share growth from the last reverse split, not across it', () => {
    const shares = [pt('2025-08-01', 50_000_000), pt('2026-02-01', 2_000_000), pt('2026-08-01', 6_000_000)];
    const r = buildDilutionReport('TST', '0000000001', facts({ shares }), subs(), NOW);
    expect(r.reverseSplitSuspected).toBe('2026-02-01');
    expect(r.shareGrowthSince).toBe('2026-02-01');
    expect(r.shareGrowthPct).toBeCloseTo(200);
  });

  it('classifies dilution filings from the last year and links to them', () => {
    const r = buildDilutionReport(
      'TST',
      '0000000001',
      facts(),
      subs([
        { form: '8-K', filed: '2026-10-01', items: '3.02,9.01' },
        { form: '8-K', filed: '2026-09-01', items: '2.02,9.01' }, // earnings: not dilution-related
        { form: '424B5', filed: '2026-08-01' },
        { form: 'S-3', filed: '2026-07-01' },
        { form: 'EFFECT', filed: '2026-07-15' },
        { form: 'S-1', filed: '2025-01-01' }, // older than a year
      ]),
      NOW,
    );
    expect(r.filings.map((f) => f.kind)).toEqual(['equity-sale', 'offering', 'registration', 'effective']);
    expect(r.filings[0]!.url).toBe('https://www.sec.gov/Archives/edgar/data/1/000000000026000000/doc.htm');
    expect(r.equitySalesSinceBalanceSheet).toBe(1);
  });

  it("doesn't score prospectus filings from well-known seasoned issuers", () => {
    const r = buildDilutionReport(
      'BIG',
      '0000000003',
      facts({ ocf: [pt('2026-06-30', 9e9, { start: '2026-01-01' })] }),
      subs([
        { form: '424B5', filed: '2026-08-01' },
        { form: 'S-3ASR', filed: '2024-05-01' },
      ]),
      NOW,
    );
    expect(r.filings[0]!.label).toContain('often debt');
    expect(r.risk.score).toBe(0);
  });

  it('leaves runway out for financial companies', () => {
    const r = buildDilutionReport('BNK', '0000000002', facts(), subs([], '6141'), NOW);
    expect(r.financial).toBe(true);
    expect(r.runwayMonths).toBeNull();
    expect(r.risk.score).toBe(0);
  });

  it('reports a cash-flow-positive company as low risk', () => {
    const ocf = [pt('2026-06-30', 5_000_000, { start: '2026-01-01' })];
    const r = buildDilutionReport('TST', '0000000001', facts({ ocf }), subs(), NOW);
    expect(r.cashFlowPositive).toBe(true);
    expect(r.monthlyBurn).toBeNull();
    expect(r.risk).toMatchObject({ score: 0, level: 'low' });
  });

  it('rates each area for the quote card', () => {
    const shares = [pt('2025-10-01', 5_000_000), pt('2026-08-01', 7_000_000)]; // +40%
    const warrants = [pt('2026-06-30', 2_000_000)]; // 29% of shares
    const filings = [
      { form: '8-K', filed: '2026-10-01', items: '3.02' },
      { form: '8-K', filed: '2026-09-01', items: '3.02' },
      { form: 'S-3', filed: '2026-03-01' },
    ];
    const r = buildDilutionReport('TST', '0000000001', facts({ shares, warrants }), subs(filings), NOW);
    expect(r.ratings).toEqual({ offering: 'medium', dilution: 'medium', frequency: 'medium', cashNeed: 'high', warrants: 'high' });
    expect(r.foreignFiler).toBe(false);
  });

  it('caps the score at 10 and rates it high', () => {
    const shares = [pt('2025-10-01', 1_000_000), pt('2026-08-01', 10_000_000)];
    const warrants = [pt('2026-06-30', 5_000_000)];
    const convertible = [pt('2026-06-30', 2_000_000)];
    const filings = [
      ...['2026-10-01', '2026-09-01', '2026-08-01'].map((filed) => ({ form: '8-K', filed, items: '3.02' })),
      { form: '424B4', filed: '2026-07-01' },
      { form: 'EFFECT', filed: '2026-07-01' },
      { form: '8-K', filed: '2026-06-01', items: '3.01' },
      { form: 'NT 10-Q', filed: '2026-05-15' },
    ];
    const r = buildDilutionReport('TST', '0000000001', facts({ shares, warrants, convertible }), subs(filings), NOW);
    expect(r.risk.reasons.reduce((s, x) => s + x.points, 0)).toBeGreaterThan(10);
    expect(r.risk).toMatchObject({ score: 10, level: 'high' });
  });
});
