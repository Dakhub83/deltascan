const DASH = '—';

export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return v.toFixed(v < 1 ? 4 : 2);
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtCompact(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(digits)}K`;
  return Math.round(v).toString();
}

export function fmtMultiple(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(v >= 10 ? 0 : 1)}×`;
}

const etTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function fmtTimeET(ms: number): string {
  return etTime.format(ms);
}

export function signClass(v: number | null | undefined): string {
  if (v == null || v === 0) return 'text-dim';
  return v > 0 ? 'text-up' : 'text-down';
}
