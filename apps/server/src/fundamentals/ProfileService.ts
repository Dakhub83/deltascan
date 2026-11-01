import type { CompanyProfile, NewsItem } from '@deltascan/shared';
import type { Logger } from '../lib/logger';
import type { AlpacaNews } from './AlpacaNews';
import type { SecClient } from './SecClient';

const NEWS_TTL_MS = 2 * 60_000;
const MAX_NEWS = 8;

/** Newest first, without the same story twice (a press release also carried by the wire). */
export function mergeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items
    .filter((n) => n.headline && Number.isFinite(n.publishedAt))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter((n) => {
      const key = n.headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_NEWS);
}

/** Company profile from SEC filings, plus Alpaca news when keys are configured. */
export class ProfileService {
  private readonly news = new Map<string, { at: number; items: NewsItem[] }>();
  private readonly log: Logger;

  constructor(
    private readonly sec: SecClient | null,
    private readonly alpaca: AlpacaNews | null,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'profile' });
  }

  get enabled(): boolean {
    return this.sec !== null || this.alpaca !== null;
  }

  async profile(symbol: string): Promise<CompanyProfile | null> {
    const [sec, wire] = await Promise.all([this.sec ? this.sec.profile(symbol) : null, this.wireNews(symbol)]);
    if (!sec && !wire.length) return null;
    return {
      symbol,
      description: sec?.description ?? null,
      descriptionSource: sec?.descriptionSource ?? null,
      country: sec?.country ?? null,
      incorporatedIn: sec?.incorporatedIn ?? null,
      adr: sec?.adr ?? null,
      news: mergeNews([...(sec?.pressReleases ?? []), ...wire]),
      newsSources: [...(this.sec ? (['sec'] as const) : []), ...(this.alpaca ? (['alpaca'] as const) : [])],
      fetchedAt: Date.now(),
    };
  }

  private async wireNews(symbol: string): Promise<NewsItem[]> {
    if (!this.alpaca) return [];
    const hit = this.news.get(symbol);
    if (hit && Date.now() - hit.at < NEWS_TTL_MS) return hit.items;
    try {
      const items = await this.alpaca.latest(symbol);
      this.news.set(symbol, { at: Date.now(), items });
      return items;
    } catch (err) {
      this.log.warn({ symbol, err: (err as Error).message }, 'alpaca news failed');
      return hit?.items ?? [];
    }
  }
}
