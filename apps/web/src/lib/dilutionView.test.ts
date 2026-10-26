import { describe, expect, it } from 'vitest';
import type { DilutionReport } from '@deltascan/shared';
import { capLabel, cashPosition, complianceLevel, floatLabel, fmtOffering, isChinaBased } from './dilutionView';

const NOW = Date.parse('2026-10-25T00:00:00Z');
const report = (over: Partial<DilutionReport> = {}) =>
  ({
    financial: false,
    cashFlowPositive: false,
    cash: { value: 4_000_000, asOf: '2026-07-27', form: '10-Q', filed: '2026-08-10' },
    monthlyBurn: 500_000,
    ratings: { offering: 'low', dilution: 'low', frequency: 'low', cashNeed: 'low', warrants: 'low', compliance: 'low' },
    ...over,
  }) as DilutionReport;

describe('dilution view helpers', () => {
  it('labels float and market cap', () => {
    expect(floatLabel(711_136)?.text).toBe('Sub-1M · extremely tight');
    expect(floatLabel(3.9e6)?.text).toBe('Low float · tight');
    expect(floatLabel(null)).toBeNull();
    expect([capLabel(2.6e6), capLabel(120e6), capLabel(1.5e9), capLabel(3e12)]).toEqual(['Nano-cap', 'Micro-cap', 'Small-cap', 'Mega-cap']);
  });

  it('flags China-based companies', () => {
    expect([isChinaBased('China'), isChinaBased('Hong Kong'), isChinaBased('United States'), isChinaBased(null)]).toEqual([true, true, false, null]);
  });

  it('carries cash forward at the burn rate', () => {
    const pos = cashPosition(report(), NOW);
    // ~3 months since Jul 27 at $500K/month leaves ~$2.5M, ~5 months.
    expect(pos).toMatchObject({ positive: false, quarterlyBurn: 1_500_000 });
    expect(pos && !pos.positive && pos.estCash).toBeCloseTo(2_520_000, -4);
    expect(pos && !pos.positive && pos.monthsLeft).toBeCloseTo(5.0, 1);
    expect(cashPosition(report({ financial: true }), NOW)).toBeNull();
  });

  it('raises compliance to medium under $1', () => {
    expect(complianceLevel(report(), 0.54)).toBe('medium');
    expect(complianceLevel(report(), 2)).toBe('low');
  });

  it('formats offering amounts', () => {
    expect(fmtOffering({ value: 4e6, upTo: false, resale: false })).toBe('$4.0M');
    expect(fmtOffering({ value: 10.5e6, upTo: true, resale: false })).toBe('up to $10.5M');
    expect(fmtOffering({ value: null, upTo: false, resale: true })).toBe('Resale');
  });
});
