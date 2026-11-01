import { describe, expect, it } from 'vitest';
import {
  countryFrom,
  coverListsAds,
  extractBusinessDescription,
  firstSentences,
  htmlToLines,
  incorporationFrom,
  parseOfferingAmount,
  parsePressRelease,
  parseReverseSplit,
} from '../src/fundamentals/filingText';
import { toNewsItem } from '../src/fundamentals/AlpacaNews';
import { mergeNews } from '../src/fundamentals/ProfileService';

const long = (s: string) => `${s} ${'It serves customers across many regions with a broad set of products and services. '.repeat(2)}`;

describe('filing text', () => {
  it('turns HTML into lines and decodes entities', () => {
    expect(htmlToLines('<p>Acme&#160;&amp; Co&#8217;s&nbsp;plan</p><div>Next<br>line</div><script>x()</script>')).toEqual([
      'Acme & Co’s plan',
      'Next',
      'line',
    ]);
  });

  it("doesn't end a sentence at Inc. or U.S.", () => {
    expect(firstSentences('Acme, Inc. makes U.S. widgets for everyone. Second sentence here. Third.', 200, 1)).toBe(
      'Acme, Inc. makes U.S. widgets for everyone.',
    );
  });

  it('skips the table of contents and boilerplate to the describing paragraph', () => {
    const html = [
      '<p>TABLE OF CONTENTS</p><p>Item 1.</p><p>Business</p><p>1</p><p>Item 1A.</p><p>Risk Factors</p>',
      '<p>Item 1 - Business</p><p>General</p>',
      `<p>${long('In this Annual Report, unless the context otherwise requires, references to “we” mean Acme.')}</p>`,
      `<p>${long('Acme was founded in 2006 in Nevada.')}</p>`,
      `<p>${long('Acme, Inc. is a leading provider of industrial sensors for oil and gas pipelines.')}</p>`,
    ].join('');
    // A short first sentence (under 100 characters) gets its follow-up too.
    expect(extractBusinessDescription(htmlToLines(html), 'Acme, Inc.')).toBe(
      'Acme, Inc. is a leading provider of industrial sensors for oil and gas pipelines. It serves customers across many regions with a broad set of products and services.',
    );
  });

  it('detects ADRs from the annual report cover', () => {
    expect(coverListsAds(htmlToLines('<p>Title of each class</p><p>American Depositary Shares, each representing eight Ordinary Shares</p>'))).toBe(true);
    expect(coverListsAds(htmlToLines('<p>Title of each class</p><p>Ordinary Shares, NIS 0.01 par value</p>'))).toBe(false);
  });

  it('reads a press release headline and summary', () => {
    const html = [
      '<p>EX-99.1</p><p>Exhibit 99.1</p><p>Vivakor</p><p>Signs LOI for Proposed $40 Million Acquisition of Direct Midstream</p>',
      '<p>Proposed Transaction Values Direct Midstream at 4x Targeted 2027 Free Cash Flow</p>',
      '<p>Dallas, TX – GlobeNewswire – October 9, 2026 – Vivakor, Inc. (Nasdaq: VIVK), an integrated provider of energy services, today announced that it has entered into a non-binding Letter of Intent. The LOI sets the principal terms. More detail follows.</p>',
    ].join('');
    expect(parsePressRelease(htmlToLines(html), 'VIVAKOR, INC.')).toEqual({
      headline: 'Vivakor Signs LOI for Proposed $40 Million Acquisition of Direct Midstream',
      summary: 'Vivakor announced that it has entered into a non-binding Letter of Intent. The LOI sets the principal terms.',
    });
  });

  it('ignores regulatory forms filed as exhibits', () => {
    expect(parsePressRelease(htmlToLines('<p>FF301 Page 1 of 10 v 1.2.1</p><p>Monthly Return for Equity Issuer</p>'))).toBeNull();
  });

  it('maps EDGAR location codes to countries', () => {
    expect(countryFrom('TX', 'TX')).toBe('United States');
    expect(countryFrom('L3', 'ISRAEL')).toBe('Israel');
    expect(countryFrom(null, null)).toBeNull();
    expect(incorporationFrom('NV', 'NV')).toBe('Nevada');
    expect(incorporationFrom('E9', 'CAYMAN ISLANDS')).toBe('Cayman Islands');
  });
});

describe('reverse splits', () => {
  const lines = (...paras: string[]) => htmlToLines(paras.map((p) => `<p>${p}</p>`).join(''));

  it('reads the ratio, effective date and resulting share count', () => {
    const doc = lines(
      'Item 5.03 Amendments to Articles of Incorporation.',
      'On July 29, 2026, the Company filed a Certificate of Amendment to effect a 1-for-5 reverse stock split of its common stock. The Reverse Stock Split became effective at 12:01 a.m. Eastern Time on July 31, 2026.',
      'Following the reverse split, there will be approximately 649,914 shares of common stock issued and outstanding.',
    );
    expect(parseReverseSplit(doc)).toEqual({ ratio: 5, effective: '2026-07-31', sharesAfter: 649_914 });
  });

  it('reads ratios written in words and ignores the approved range', () => {
    const doc = lines(
      'At the annual meeting, stockholders approved a reverse stock split at a ratio in the range of 1-for-2 to 1-for-50.',
      'The Board then approved a one-for-twenty (1:20) reverse stock split, effective on March 3, 2026.',
    );
    expect(parseReverseSplit(doc)).toEqual({ ratio: 20, effective: '2026-03-03', sharesAfter: null });
  });

  it('returns null for charter amendments that are not splits', () => {
    expect(parseReverseSplit(lines('The Board amended the Bylaws to change the quorum requirement.'))).toBeNull();
    expect(parseReverseSplit(lines('Stockholders approved a reverse stock split within a range of 1-for-2 to 1-for-30 at the discretion of the Board.'))).toBeNull();
  });
});

describe('offering amounts', () => {
  const lines = (text: string) => htmlToLines(`<p>${text}</p>`);

  it('reads ATM maximums, gross proceeds and resales', () => {
    expect(parseOfferingAmount(lines('We may offer and sell shares of our common stock having an aggregate offering price of up to $10,500,000 from time to time.'))).toEqual({
      value: 10_500_000,
      upTo: true,
      resale: false,
    });
    expect(parseOfferingAmount(lines('Common stock, par value $0.0001. We expect to receive gross proceeds of approximately $4.0 million from this offering.'))).toEqual({
      value: 4_000_000,
      upTo: false,
      resale: false,
    });
    expect(parseOfferingAmount(lines('The selling stockholders may sell shares. We will not receive any of the proceeds from the sale of the shares.'))).toEqual({
      value: null,
      upTo: false,
      resale: true,
    });
    expect(parseOfferingAmount(lines('Par value $0.001 per share.'))).toBeNull();
  });
});

describe('news', () => {
  it('maps Alpaca articles', () => {
    expect(toNewsItem({ headline: ' Acme Prices Offering ', summary: '', url: 'https://x', source: 'benzinga', created_at: '2026-10-25T13:00:00Z' })).toEqual({
      headline: 'Acme Prices Offering',
      summary: null,
      url: 'https://x',
      source: 'Benzinga',
      publishedAt: Date.parse('2026-10-25T13:00:00Z'),
      kind: 'newswire',
    });
  });

  it('merges newest first and drops the same story from a second source', () => {
    const item = (headline: string, at: number, kind: 'press-release' | 'newswire') => ({ headline, summary: null, url: '', source: kind, publishedAt: at, kind });
    const merged = mergeNews([
      item('Acme Announces $5M Registered Direct Offering', 100, 'press-release'),
      item('Acme announces $5M registered direct offering', 90, 'newswire'),
      item('Acme Regains Nasdaq Compliance', 200, 'newswire'),
    ]);
    expect(merged.map((n) => [n.headline, n.kind])).toEqual([
      ['Acme Regains Nasdaq Compliance', 'newswire'],
      ['Acme Announces $5M Registered Direct Offering', 'press-release'],
    ]);
  });
});
