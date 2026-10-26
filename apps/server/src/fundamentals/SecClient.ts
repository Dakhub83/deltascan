import type { DilutionReport } from '@deltascan/shared';
import type { Logger } from '../lib/logger';
import { buildDilutionReport, type CompanyFacts, type Submissions } from './dilution';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_TTL_MS = 24 * 3600_000;
const REPORT_TTL_MS = 6 * 3600_000;
const MAX_CACHED_REPORTS = 200;
/** SEC allows 10 requests/second per client; stay well under it. */
const MIN_REQUEST_GAP_MS = 150;

/**
 * Fetches and caches SEC EDGAR data. Concurrent requests for the same symbol share one fetch.
 * See https://www.sec.gov/os/accessing-edgar-data for the fair-access rules.
 */
export class SecClient {
  private tickers: { at: number; map: Map<string, string> } | null = null;
  private readonly reports = new Map<string, { at: number; report: DilutionReport }>();
  private readonly inflight = new Map<string, Promise<DilutionReport | null>>();
  private nextSlot = 0;
  private readonly log: Logger;

  constructor(
    private readonly userAgent: string,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'sec' });
  }

  /** Dilution report for a ticker, or null if SEC has no company for it. */
  dilution(symbol: string): Promise<DilutionReport | null> {
    const key = symbol.toUpperCase();
    const cached = this.reports.get(key);
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) return Promise.resolve(cached.report);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.load(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async load(symbol: string): Promise<DilutionReport | null> {
    const cik = await this.cikFor(symbol);
    if (!cik) return null;
    const [facts, subs] = await Promise.all([
      this.getJson<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`).catch((err: Error) => {
        // Some filers (e.g. many foreign issuers) have no XBRL facts; the filings list still helps.
        if (err.message.includes('404')) return { facts: {} };
        throw err;
      }),
      this.getJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`),
    ]);
    const report = buildDilutionReport(symbol, cik, facts, subs);
    this.reports.set(symbol, { at: Date.now(), report });
    if (this.reports.size > MAX_CACHED_REPORTS) this.reports.delete(this.reports.keys().next().value!);
    this.log.info({ symbol, score: report.risk.score }, 'dilution report built');
    return report;
  }

  private async cikFor(symbol: string): Promise<string | null> {
    if (!this.tickers || Date.now() - this.tickers.at > TICKERS_TTL_MS) {
      const raw = await this.getJson<Record<string, { cik_str: number; ticker: string }>>(TICKERS_URL);
      const map = new Map<string, string>();
      for (const t of Object.values(raw)) map.set(t.ticker.toUpperCase(), String(t.cik_str).padStart(10, '0'));
      this.tickers = { at: Date.now(), map };
    }
    // SEC writes share classes with a dash (BRK-B); feeds usually use a dot (BRK.B).
    return this.tickers.map.get(symbol.replace('.', '-')) ?? null;
  }

  private async getJson<T>(url: string): Promise<T> {
    const wait = Math.max(0, this.nextSlot - Date.now());
    this.nextSlot = Date.now() + wait + MIN_REQUEST_GAP_MS;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
    return (await res.json()) as T;
  }
}
