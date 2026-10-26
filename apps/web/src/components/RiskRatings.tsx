import type { DilutionReport, RiskLevel } from '@deltascan/shared';
import clsx from 'clsx';
import { complianceLevel } from '../lib/dilutionView';

const DOT: Record<RiskLevel, string> = { low: 'bg-up', medium: 'bg-warn', high: 'bg-down' };
const TEXT: Record<RiskLevel, string> = { low: 'text-up', medium: 'text-warn', high: 'text-down' };

const TIPS: Record<string, string> = {
  offering: 'Shelf registrations, prospectuses and effective registrations: can the company sell shares right now?',
  frequency: 'How often it has raised in the last year (offerings and unregistered equity sales)',
  dilution: 'Growth in shares outstanding, adjusted for reverse splits announced in 8-Ks',
  cashNeed: 'Months of cash left at the reported burn rate',
  warrants: 'Outstanding warrants as a share of shares outstanding',
  compliance: 'Exchange deficiency notices (8-K 3.01), late filings, recent reverse splits, and trading under $1',
};

/** "● Offering Ability: Medium" rows, in two columns when there's room. */
export function RiskRatings({ report, price, className }: { report: DilutionReport; price: number | null; className?: string }) {
  const rows: { key: string; label: string; value: RiskLevel | null }[] = [
    { key: 'offering', label: 'Offering Ability', value: report.ratings.offering },
    { key: 'frequency', label: 'Offering Frequency', value: report.ratings.frequency },
    { key: 'dilution', label: 'Dilution', value: report.ratings.dilution },
    { key: 'cashNeed', label: 'Cash Need', value: report.ratings.cashNeed },
    { key: 'warrants', label: 'Warrant Exercise', value: report.ratings.warrants },
    { key: 'compliance', label: `${report.exchange ?? 'Exchange'} Compliance`, value: complianceLevel(report, price) },
  ];
  return (
    <ul className={clsx('grid grid-cols-1 gap-x-6 gap-y-1 @[380px]:grid-cols-2', className)}>
      {rows.map((r) => (
        <li key={r.key} title={TIPS[r.key]} className="flex items-center gap-2 text-[12px]">
          <span className={clsx('size-2.5 shrink-0 rounded-full', r.value ? DOT[r.value] : 'bg-line-strong')} />
          <span className="text-dim">{r.label}:</span>
          <span className={clsx('font-semibold capitalize', r.value ? TEXT[r.value] : 'text-muted')}>{r.value ?? 'N/A'}</span>
        </li>
      ))}
    </ul>
  );
}
