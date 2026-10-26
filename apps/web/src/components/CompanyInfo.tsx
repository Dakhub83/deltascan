import { useEffect, useState } from 'react';
import type { CompanyProfile, NewsItem } from '@deltascan/shared';
import { ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { marketData, type ProfileResult } from '../lib/marketData';
import { isChinaBased } from '../lib/dilutionView';

const etNewsTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function useCompanyProfile(symbol: string | null): ProfileResult | 'loading' | null {
  const [result, setResult] = useState<ProfileResult | 'loading' | null>(null);
  useEffect(() => {
    if (!symbol) return setResult(null);
    let cancelled = false;
    setResult('loading');
    void marketData.fetchProfile(symbol).then((r) => !cancelled && setResult(r));
    return () => {
      cancelled = true;
    };
  }, [symbol]);
  return result;
}

const YesNo = ({ yes }: { yes: boolean }) => <span className={yes ? 'text-warn' : 'text-up'}>{yes ? 'Yes' : 'No'}</span>;

/** "Country: United States • China: No • ADR: No • Inc. Nevada" */
export function CompanyFacts({ profile, className }: { profile: CompanyProfile | null; className?: string }) {
  const china = isChinaBased(profile?.country);
  return (
    <div className={clsx('flex flex-wrap gap-x-3 gap-y-0.5', className)}>
      <span>
        Country: <span className="text-fg">{profile?.country ?? 'N/A'}</span>
      </span>
      <span title="China-based by business address (Hong Kong and Macau included)">
        China: {china === null ? <span className="text-muted">N/A</span> : <YesNo yes={china} />}
      </span>
      <span title="From the annual report cover: ADRs list American Depositary Shares">
        ADR: {profile?.adr == null ? <span className="text-muted">N/A</span> : <YesNo yes={profile.adr} />}
      </span>
      {profile?.incorporatedIn && <span className="text-muted">Inc. {profile.incorporatedIn}</span>}
    </div>
  );
}

export function CompanyDescription({ profile, loading }: { profile: CompanyProfile | null; loading: boolean }) {
  if (loading) return <p className="text-[12px] text-muted">Loading company description…</p>;
  if (!profile?.description) {
    return (
      <p className="text-[12px] text-muted">
        No description found in the latest annual report
        {profile?.descriptionSource && (
          <>
            {' '}
            (
            <a href={profile.descriptionSource.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              open {profile.descriptionSource.form}
            </a>
            )
          </>
        )}
        .
      </p>
    );
  }
  return (
    <p className="text-[12px] leading-relaxed text-dim">
      {profile.description}{' '}
      {profile.descriptionSource && (
        <a href={profile.descriptionSource.url} target="_blank" rel="noreferrer" className="whitespace-nowrap text-[10px] text-muted hover:text-accent">
          {profile.descriptionSource.form}, {shortDate(profile.descriptionSource.filed)}
        </a>
      )}
    </p>
  );
}

function NewsRow({ item }: { item: NewsItem }) {
  return (
    <li className="border-b border-line/60 py-2 last:border-0">
      <div className="mb-0.5 flex items-center gap-2 text-[10px] text-muted">
        <span className="num">{etNewsTime.format(item.publishedAt)} ET</span>
        <span
          className={clsx(
            'rounded px-1 py-px font-semibold tracking-wide',
            item.kind === 'press-release' ? 'bg-accent/12 text-accent' : 'bg-line text-dim',
          )}
        >
          {item.kind === 'press-release' ? `PRESS RELEASE · ${item.source.replace('SEC ', '')}` : item.source.toUpperCase()}
        </span>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer" className="group flex items-start gap-1 text-[12px] font-semibold leading-snug text-fg hover:text-accent">
        <span>{item.headline}</span>
        <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-0 group-hover:opacity-100" />
      </a>
      {item.summary && <p className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-dim">{item.summary}</p>}
    </li>
  );
}

export function NewsList({ result }: { result: ProfileResult | 'loading' | null }) {
  if (result === 'loading' || result === null) return <p className="text-[12px] text-muted">Loading news…</p>;
  if (!result.ok) {
    return (
      <p className="text-[12px] text-muted">
        {result.reason === 'setup' ? 'News is off: set SEC_USER_AGENT (and optionally Alpaca keys) in .env and restart.' : 'No news available.'}
      </p>
    );
  }
  const { news, newsSources } = result.profile;
  return (
    <>
      {news.length ? <ul>{news.map((n) => <NewsRow key={n.url + n.publishedAt} item={n} />)}</ul> : <p className="text-[12px] text-muted">No news available.</p>}
      {!newsSources.includes('alpaca') && (
        <p className="mt-1 text-[10px] text-muted">Company press releases from SEC filings only. Add Alpaca API keys to .env for newswire headlines.</p>
      )}
    </>
  );
}
