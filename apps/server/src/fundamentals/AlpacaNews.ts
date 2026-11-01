import type { NewsItem } from '@deltascan/shared';

const NEWS_URL = 'https://data.alpaca.markets/v1beta1/news';

/** One article as Alpaca's news API returns it (Benzinga feed). */
export interface AlpacaArticle {
  headline: string;
  summary?: string;
  url?: string;
  source?: string;
  created_at: string;
}

export function toNewsItem(a: AlpacaArticle): NewsItem {
  return {
    headline: a.headline.trim(),
    summary: a.summary?.trim() || null,
    url: a.url ?? '',
    source: a.source ? a.source[0]!.toUpperCase() + a.source.slice(1) : 'Alpaca',
    publishedAt: Date.parse(a.created_at),
    kind: 'newswire',
  };
}

/** Alpaca's free news API; uses the same keys as the market-data stream. */
export class AlpacaNews {
  constructor(
    private readonly keyId: string,
    private readonly secretKey: string,
  ) {}

  async latest(symbol: string, limit = 8): Promise<NewsItem[]> {
    const url = `${NEWS_URL}?symbols=${encodeURIComponent(symbol)}&limit=${limit}&sort=desc`;
    const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secretKey } });
    if (!res.ok) throw new Error(`Alpaca news ${res.status}`);
    const body = (await res.json()) as { news?: AlpacaArticle[] };
    return (body.news ?? []).map(toNewsItem);
  }
}
