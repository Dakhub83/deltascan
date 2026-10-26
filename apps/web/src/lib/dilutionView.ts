import type { DilutionReport, OfferingAmount, RiskLevel } from '@deltascan/shared';
import { fmtCompact } from './format';

const MONTH_MS = 30.44 * 86_400_000;

export type Tone = 'up' | 'down' | 'warn' | 'dim';

/** Float buckets as small-cap traders talk about them. */
export function floatLabel(float: number | null | undefined): { text: string; tone: Tone } | null {
  if (float == null) return null;
  if (float < 1e6) return { text: 'Sub-1M · extremely tight', tone: 'down' };
  if (float < 5e6) return { text: 'Low float · tight', tone: 'down' };
  if (float < 10e6) return { text: 'Low float', tone: 'warn' };
  if (float < 20e6) return { text: 'Mid float', tone: 'dim' };
  return { text: 'High float', tone: 'dim' };
}

export function capLabel(cap: number | null | undefined): string | null {
  if (cap == null) return null;
  if (cap < 50e6) return 'Nano-cap';
  if (cap < 300e6) return 'Micro-cap';
  if (cap < 2e9) return 'Small-cap';
  if (cap < 10e9) return 'Mid-cap';
  if (cap < 200e9) return 'Large-cap';
  return 'Mega-cap';
}

/** China-based by business address (Hong Kong and Macau included); null when the country is unknown. */
export function isChinaBased(country: string | null | undefined): boolean | null {
  if (!country) return null;
  return /\bchina\b|hong kong|macau|macao/i.test(country);
}

/** Cash carried forward from the last balance sheet at the reported burn rate. */
export function cashPosition(report: DilutionReport, now = Date.now()) {
  if (report.financial) return null;
  if (report.cashFlowPositive) return { positive: true as const, estCash: report.cash?.value ?? null };
  if (!report.cash || !report.monthlyBurn) return null;
  const elapsed = (now - Date.parse(`${report.cash.asOf}T00:00:00Z`)) / MONTH_MS;
  const estCash = Math.max(0, report.cash.value - report.monthlyBurn * elapsed);
  return { positive: false as const, estCash, monthsLeft: estCash / report.monthlyBurn, quarterlyBurn: report.monthlyBurn * 3 };
}

/** The exchange's $1 minimum bid rule: trading under it starts the deficiency clock. */
export function complianceLevel(report: DilutionReport, price: number | null): RiskLevel | null {
  const filed = report.ratings.compliance;
  if (price !== null && price < 1 && (filed === 'low' || filed === null)) return 'medium';
  return filed;
}

export function fmtOffering(amount: OfferingAmount): string {
  if (amount.resale) return 'Resale';
  if (amount.value === null) return '';
  return `${amount.upTo ? 'up to ' : ''}$${fmtCompact(amount.value)}`;
}
