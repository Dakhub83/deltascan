import type { DilutionReport, NewsItem } from '@deltascan/shared';
import type { Logger } from '../lib/logger';
import { buildDilutionReport, filingsToRead, type CompanyFacts, type FilingDetails, type Submissions } from './dilution';
import {
  countryFrom,
  coverListsAds,
  extractBusinessDescription,
  htmlToLines,
  incorporationFrom,
  parseOfferingAmount,
  parsePressRelease,
  parseReverseSplit,
} from './filingText';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_TTL_MS = 24 * 3600_000;
const REPORT_TTL_MS = 6 * 3600_000;
/** Submissions change when the company files; both the dilution report and the profile read them. */
const SUBMISSIONS_TTL_MS = 10 * 60_000;
const MAX_CACHED = 200;
/** SEC allows 10 requests/second per client; stay well under it. */
const MIN_REQUEST_GAP_MS = 150;
/** Annual reports run to 10+ MB; the Business section is well inside the first few. */
const ANNUAL_REPORT_MAX_BYTES = 5_000_000;
const PRESS_RELEASE_MAX_BYTES = 400_000;
/** Split ratios sit in the 8-K body; offering sizes on the prospectus cover and summary. */
const FILING_DETAIL_MAX_BYTES = 400_000;
const PRESS_RELEASES = 4;
const PRESS_RELEASE_DAYS = 60;
/** 8-K items that usually carry a press release as exhibit 99.1. */
const PRESS_ITEMS = /\b(2\.02|7\.01|8\.01)\b/;

/** What SEC filings say about a company, apart from the numbers. */
export interface SecProfile {
  name: string;
  description: string | null;
  descriptionSource: { form: string; filed: string; url: string } | null;
  country: string | null;
  incorporatedIn: string | null;
  adr: boolean | null;
  pressReleases: NewsItem[];
}

interface Cached<T> {
  at: number;
  value: T;
}

/**
 * Fetches and caches SEC EDGAR data. Concurrent requests for the same key share one fetch.
 * See https://www.sec.gov/os/accessing-edgar-data for the fair-access rules.
 */
export class SecClient {
  private tickers: { at: number; map: Map<string, string> } | null = null;
  private readonly reports = new Map<string, Cached<DilutionReport>>();
  private readonly profiles = new Map<string, Cached<SecProfile>>();
  private readonly submissions = new Map<string, Cached<Submissions>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
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
    return this.memo(this.reports, `report:${symbol}`, symbol.toUpperCase(), REPORT_TTL_MS, () => this.loadReport(symbol.toUpperCase()));
  }

  /** Description, country, ADR status and recent press releases, or null if SEC has no company for it. */
  profile(symbol: string): Promise<SecProfile | null> {
    return this.memo(this.profiles, `profile:${symbol}`, symbol.toUpperCase(), REPORT_TTL_MS, () => this.loadProfile(symbol.toUpperCase()));
  }

  private async memo<T>(cache: Map<string, Cached<T>>, flightKey: string, key: string, ttl: number, load: () => Promise<T | null>): Promise<T | null> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    let pending = this.inflight.get(flightKey) as Promise<T | null> | undefined;
    if (!pending) {
      pending = load()
        .then((value) => {
          if (value !== null) {
            cache.set(key, { at: Date.now(), value });
            if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
          }
          return value;
        })
        .finally(() => this.inflight.delete(flightKey));
      this.inflight.set(flightKey, pending);
    }
    return pending;
  }

  private async loadReport(symbol: string): Promise<DilutionReport | null> {
    const cik = await this.cikFor(symbol);
    if (!cik) return null;
    const [facts, subs] = await Promise.all([
      this.getJson<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`).catch((err: Error) => {
        // Some filers (e.g. many foreign issuers) have no XBRL facts; the filings list still helps.
        if (err.message.includes('404')) return { facts: {} };
        throw err;
      }),
      this.submissionsFor(cik),
    ]);
    const report = buildDilutionReport(symbol, cik, facts, subs, await this.filingDetails(symbol, cik, subs));
    this.log.info({ symbol, score: report.risk.score }, 'dilution report built');
    return report;
  }

  private async filingDetails(symbol: string, cik: string, subs: Submissions): Promise<FilingDetails> {
    const details: FilingDetails = { splits: new Map(), amounts: new Map() };
    for (const { url, read } of filingsToRead(subs, cik)) {
      try {
        const lines = htmlToLines(await this.getText(url, FILING_DETAIL_MAX_BYTES));
        if (read === 'split') {
          const split = parseReverseSplit(lines);
          if (split) details.splits.set(url, split);
        } else {
          const amount = parseOfferingAmount(lines);
          if (amount) details.amounts.set(url, amount);
        }
      } catch (err) {
        this.log.warn({ symbol, url, err: (err as Error).message }, 'filing text fetch failed');
      }
    }
    return details;
  }

  private async loadProfile(symbol: string): Promise<SecProfile | null> {
    const cik = await this.cikFor(symbol);
    if (!cik) return null;
    const subs = await this.submissionsFor(cik);
    const r = subs.filings.recent;
    const archive = (i: number, file = r.primaryDocument[i]!) =>
      `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i]!.replaceAll('-', '')}/${file}`;

    // Description and ADR status come from the latest annual report; a failure there shouldn't sink the rest.
    let description: string | null = null;
    let descriptionSource: SecProfile['descriptionSource'] = null;
    let adr: boolean | null = null;
    const annual = r.form.findIndex((f) => f === '10-K' || f === '20-F' || f === '40-F');
    if (annual !== -1) {
      try {
        const lines = htmlToLines(await this.getText(archive(annual), ANNUAL_REPORT_MAX_BYTES));
        description = extractBusinessDescription(lines, subs.name);
        descriptionSource = { form: r.form[annual]!, filed: r.filingDate[annual]!, url: archive(annual) };
        adr = r.form[annual] === '10-K' ? false : coverListsAds(lines);
      } catch (err) {
        this.log.warn({ symbol, err: (err as Error).message }, 'annual report fetch failed');
      }
    }

    const pressReleases: NewsItem[] = [];
    const cutoff = Date.now() - PRESS_RELEASE_DAYS * 86_400_000;
    for (let i = 0; i < r.form.length && pressReleases.length < PRESS_RELEASES; i++) {
      const filedAt = Date.parse(r.acceptanceDateTime?.[i] ?? `${r.filingDate[i]}T12:00:00Z`);
      if (filedAt < cutoff) break;
      const form = r.form[i]!;
      if (!(form === '6-K' || (form.startsWith('8-K') && PRESS_ITEMS.test(r.items[i] ?? '')))) continue;
      try {
        const index = await this.getJson<{ directory: { item: { name: string }[] } }>(archive(i, 'index.json'));
        const exhibit = index.directory.item.find((f) => /ex-?99[-_.]?0?1\b|ex991|exhibit99/i.test(f.name) && /\.html?$/i.test(f.name));
        if (!exhibit) continue;
        const parsed = parsePressRelease(htmlToLines(await this.getText(archive(i, exhibit.name), PRESS_RELEASE_MAX_BYTES)), subs.name);
        if (parsed) {
          pressReleases.push({ ...parsed, url: archive(i, exhibit.name), source: `SEC ${form}`, publishedAt: filedAt, kind: 'press-release' });
        }
      } catch (err) {
        this.log.warn({ symbol, err: (err as Error).message }, 'press release fetch failed');
      }
    }

    const business = subs.addresses?.business;
    const mailing = subs.addresses?.mailing;
    return {
      name: subs.name,
      description,
      descriptionSource,
      country:
        countryFrom(business?.stateOrCountry, business?.stateOrCountryDescription) ??
        countryFrom(mailing?.stateOrCountry, mailing?.stateOrCountryDescription) ??
        countryFrom(subs.stateOfIncorporation, subs.stateOfIncorporationDescription),
      incorporatedIn: incorporationFrom(subs.stateOfIncorporation, subs.stateOfIncorporationDescription),
      adr,
      pressReleases,
    };
  }

  private async submissionsFor(cik: string): Promise<Submissions> {
    const hit = this.submissions.get(cik);
    if (hit && Date.now() - hit.at < SUBMISSIONS_TTL_MS) return hit.value;
    const value = await this.getJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`);
    this.submissions.set(cik, { at: Date.now(), value });
    if (this.submissions.size > MAX_CACHED) this.submissions.delete(this.submissions.keys().next().value!);
    return value;
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

  private async request(url: string): Promise<Response> {
    const wait = Math.max(0, this.nextSlot - Date.now());
    this.nextSlot = Date.now() + wait + MIN_REQUEST_GAP_MS;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
    return res;
  }

  private async getJson<T>(url: string): Promise<T> {
    return (await (await this.request(url)).json()) as T;
  }

  /** Reads at most `maxBytes` (SEC ignores Range headers, so the stream is cut off instead). */
  private async getText(url: string, maxBytes: number): Promise<string> {
    const reader = (await this.request(url)).body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}
