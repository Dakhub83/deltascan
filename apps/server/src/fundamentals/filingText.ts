/** Plain-text extraction from SEC HTML filings: business descriptions, ADR detection and press releases. */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/** HTML → trimmed, non-empty text lines (one per block element). */
export function htmlToLines(html: string): string[] {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/title)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A period after these doesn't end a sentence ("Vivakor, Inc. announced…", "U.S. operations"). */
const ABBREVIATION = /\b(inc|corp|co|ltd|llc|plc|no|nos|mr|ms|mrs|dr|st|jr|sr|vs|approx|u\.s|e\.g|i\.e|n\.v|s\.a|a\.m|p\.m)\.$/i;

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const end = /[.!?](?=\s+[“"(]?[A-Z0-9])/g;
  let start = 0;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const sentence = text.slice(start, m.index + 1);
    if (ABBREVIATION.test(sentence)) continue;
    out.push(sentence.trim());
    start = m.index + 1;
  }
  if (start < text.length) out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** Trims to whole sentences within `max` characters. */
export function firstSentences(text: string, max: number, sentences = 2): string {
  let out = '';
  for (const s of splitSentences(text).slice(0, sentences)) {
    if (out && `${out} ${s}`.length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '');
  return out.length < text.length && !/[.!?]$/.test(out) ? `${out}…` : out;
}

const BUSINESS_HEADINGS = [
  /^item\s*1\s*[.:\-–—]?\s*business\b\.?$/i,
  /^(b\.\s*)?business overview$/i,
  /^business\.?$/i,
];
/** Definitions, safe-harbor, cover-page and legal-structure text that opens many sections. */
const BOILERPLATE =
  /unless the context|refers? to|references to|forward-looking|reverse (stock )?split|this annual report|as used in|check mark|shell company|does not directly engage|holding company|rely to a significant extent|exempted company|incorporated (with|under)|human capital/i;
/** "X is a leading provider of …": the classic one-line description. */
const IDENTITY = /\b(is|are) (a|an|one of the)\b[^.]{0,90}\b(provider|company|developer|manufacturer|platform|bank|operator|producer|designer|supplier|firm)\b/i;
/** Sentences that say what the company does ("operates" alone is too vague to count). */
const DESCRIPTIVE = /\b(engaged in|provides?|provider of|designs?|develops?|manufactur|offers?|delivers?|focused on|specializ)/i;
const PARAGRAPH = 100;

const sectionParagraphs = (lines: string[], i: number) =>
  lines
    .slice(i + 1, i + 60)
    .filter((l) => l.length >= PARAGRAPH && !BOILERPLATE.test(l))
    .slice(0, 6);

/** First Business heading followed by a real paragraph (the table of contents has none). */
function businessSection(lines: string[]): number {
  for (const heading of BUSINESS_HEADINGS) {
    const i = lines.findIndex((l, j) => heading.test(l) && lines.slice(j + 1, j + 16).some((n) => n.length >= PARAGRAPH && !/^item\s*\d/i.test(n)));
    if (i !== -1) return i;
  }
  return -1;
}

function aboutCompany(line: string, companyName: string): boolean {
  const first = companyName.split(/[\s,]+/)[0];
  return /^we are (a|an)\b/i.test(line) || (!!first && first.length > 2 && line.toLowerCase().startsWith(first.toLowerCase()));
}

/**
 * A short description from a 10-K (Item 1) or 20-F (Item 4.B), in order of preference:
 * an "X is a … provider/company" sentence in the Business section, then anywhere past the
 * cover page, then a paragraph saying what the company provides or makes, then the
 * section's first paragraph. Outside the section, the sentence must be about the company
 * itself (it starts with its name, or "We are a …"), not a director bio or a subsidiary.
 */
export function extractBusinessDescription(lines: string[], companyName = ''): string | null {
  const start = businessSection(lines);
  const section = start === -1 ? [] : sectionParagraphs(lines, start);
  const isIdentity = (l: string) => l.length >= 80 && IDENTITY.test(l.slice(0, 250)) && !BOILERPLATE.test(l);
  const pick =
    section.find(isIdentity) ??
    lines.slice(150, 6000).find((l) => isIdentity(l) && aboutCompany(l, companyName)) ??
    section.find((p) => DESCRIPTIVE.test(p.slice(0, 200))) ??
    section[0];
  if (!pick) return null;
  // One sentence is enough when it's already a full description.
  return firstSentences(pick, 420, (splitSentences(pick)[0]?.length ?? 0) >= 100 ? 1 : 2);
}

/** ADRs say so on the annual report's cover page. */
export function coverListsAds(lines: string[]): boolean {
  return /american depositary (shares|receipts)/i.test(lines.slice(0, 400).join(' '));
}

const WIRES = /globe ?newswire|business ?wire|pr ?newswire|accesswire|access newswire|newsfile|marketwired|cision/i;
const MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},\s+\d{4}\b/i;
const EXHIBIT_LABEL = /^(ex-?99[.\d-]*|exhibit\s*99[.\d]*|\d+|[\w-]+\.html?|for immediate release)$/i;
/** "Dallas, TX – GlobeNewswire – October 9, 2026 – " (wire and order vary). */
const DATELINE_PREFIX = /^.{0,160}?\b\d{4}\b\s*\)?\s*[-–—/]+\s*(\(?(globe ?newswire|business ?wire|pr ?newswire|accesswire)\)?\s*[-–—]+\s*)?/i;

/** Regulatory forms filed as exhibits (Hong Kong returns, etc.), not news. */
const NOT_NEWS = /page \d+ of \d+|monthly return|next day disclosure|^ff\d{3}\b/i;
/** "Acme, Inc. (Nasdaq: ACME) (“Acme” or the “Company”), a provider of …, today announced that …" */
const ANNOUNCED = /^(.{40,320}?)\b(?:today |recently )?announced(?: today)?(?: that)?\s+/i;

/**
 * Headline and summary from a press-release exhibit (EX-99.1). The headline is the short lines
 * before the dateline paragraph; the summary is that paragraph with the dateline stripped and the
 * company's standard self-description shortened to its name.
 */
export function parsePressRelease(lines: string[], companyName = ''): { headline: string; summary: string | null } | null {
  const dateline = lines.findIndex((l, i) => i < 40 && l.length >= 120 && (WIRES.test(l.slice(0, 160)) || MONTH_DATE.test(l.slice(0, 120))));
  const head = lines.slice(0, dateline === -1 ? 12 : dateline).filter((l) => !EXHIBIT_LABEL.test(l) && l.length < 200);
  if (!head.length) return null;
  // Company name and title are often split across lines; stop once it reads as a headline.
  let headline = '';
  for (const l of head) {
    headline = headline ? `${headline} ${l}` : l;
    if (headline.length >= 40) break;
  }
  if (NOT_NEWS.test(headline)) return null;
  let body = dateline === -1 ? null : lines[dateline]!.replace(DATELINE_PREFIX, '');
  const shortName = titleCase(companyName.split(/[\s,]+/)[0] ?? '');
  if (body && shortName && ANNOUNCED.test(body)) body = body.replace(ANNOUNCED, `${shortName} announced that `).replace(/that that /, 'that ');
  return { headline: firstSentences(headline, 180, 1).replace(/…$/, ''), summary: body ? firstSentences(body, 320) : null };
}

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** Place of incorporation: a US state's full name, or the country EDGAR gives. */
export function incorporationFrom(code: string | null | undefined, description: string | null | undefined): string | null {
  if (code && US_STATES[code]) return US_STATES[code];
  return description ? titleCase(description) : code || null;
}

/** EDGAR state/country codes: US states are two letters; foreign codes contain a digit (e.g. L3 Israel). */
export function countryFrom(code: string | null | undefined, description: string | null | undefined): string | null {
  if (!code) return null;
  if (/^[A-Z]{2}$/.test(code)) return 'United States';
  return description ? titleCase(description) : null;
}

const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, 'twenty-five': 25, thirty: 30, 'thirty-five': 35, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, 'seventy-five': 75, eighty: 80, hundred: 100, 'one hundred': 100, 'two hundred': 200,
  'two hundred fifty': 250,
};
const NUMBER = String.raw`(\d{1,4}|${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join('|')})`;
/** "1-for-5", "one-for-twenty (1:20)", "1:10". */
const RATIO = new RegExp(String.raw`\b(?:1|one)\s*(?:[-‐–]\s*for\s*[-‐–]|\s+for\s+|:)\s*${NUMBER}\b`, 'gi');
/** Shareholder approvals give a range ("between 1-for-2 and 1-for-30"); those ratios aren't the split. */
const RANGE = /\brange\b|\bbetween\b|\bup to\b|\bnot (?:less|more|greater) than\b|\bwithin\b|\bdiscretion\b/i;
const REVERSE = /reverse (?:stock |share )?split|share consolidation/i;
const LONG_DATE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/;
const SHARES_AFTER = /(?:approximately|about)\s+([\d,]{5,})\s+shares of (?:the Company[’']s |our )?(?:common stock|ordinary shares|class a common stock)[^.]{0,80}?\boutstanding/i;

const toNumber = (s: string) => (/^\d/.test(s) ? Number(s) : WORD_NUMBERS[s.toLowerCase()]);
const isoDate = (m: RegExpMatchArray) =>
  new Date(Date.UTC(Number(m[3]), new Date(`${m[1]} 1, 2000`).getMonth(), Number(m[2]))).toISOString().slice(0, 10);

/**
 * A reverse split's ratio, effective date and resulting share count from an 8-K (item 5.03 / 3.03).
 * Null when the filing doesn't announce a split or only authorizes a range of ratios.
 */
export function parseReverseSplit(lines: string[]): { ratio: number | null; effective: string | null; sharesAfter: number | null } | null {
  const sentences = splitSentences(lines.join(' ')).filter((s) => REVERSE.test(s) || SHARES_AFTER.test(s));
  if (!sentences.some((s) => REVERSE.test(s))) return null;

  const counts = new Map<number, number>();
  for (const s of sentences) {
    if (!REVERSE.test(s) || RANGE.test(s)) continue;
    for (const m of s.matchAll(RATIO)) {
      const n = toNumber(m[1]!);
      if (n && n > 1) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  const ratio = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let effective: string | null = null;
  for (const s of sentences) {
    const at = s.search(/\beffective\b/i);
    if (at === -1 || !REVERSE.test(s)) continue;
    const date = s.slice(at).match(LONG_DATE);
    if (date) {
      effective = isoDate(date);
      break;
    }
  }
  if (ratio === null && effective === null) return null;
  const after = sentences.map((s) => s.match(SHARES_AFTER)).find(Boolean);
  return { ratio, effective, sharesAfter: after ? Number(after[1]!.replaceAll(',', '')) : null };
}

const DOLLARS = String.raw`\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?`;
const ATM = new RegExp(String.raw`aggregate offering price of up to\s+` + DOLLARS, 'i');
const UP_TO = new RegExp(String.raw`\bup to\s+` + DOLLARS + String.raw`\s+of\s+(?:our\s+|its\s+)?(?:shares|common|ordinary|units|securities|american depositary)`, 'i');
const GROSS = new RegExp(String.raw`gross proceeds[^.$]{0,100}?` + DOLLARS, 'i');
const RESALE = /will not receive any (?:of the )?proceeds from the (?:sale|resale|offering)/i;
/** Below this it's a par value or a fee, not an offering. */
const MIN_OFFERING = 50_000;

/** Offering size from the front of a 424B prospectus. */
export function parseOfferingAmount(lines: string[]): { value: number | null; upTo: boolean; resale: boolean } | null {
  const text = lines.join(' ').slice(0, 150_000);
  const amount = (m: RegExpMatchArray | null) => {
    if (!m) return null;
    const v = Number(m[1]!.replaceAll(',', '')) * (m[2]?.toLowerCase() === 'billion' ? 1e9 : m[2] ? 1e6 : 1);
    return v >= MIN_OFFERING ? v : null;
  };
  const atm = amount(text.match(ATM)) ?? amount(text.match(UP_TO));
  if (atm !== null) return { value: atm, upTo: true, resale: false };
  const gross = amount(text.match(GROSS));
  if (gross !== null) return { value: gross, upTo: false, resale: false };
  return RESALE.test(text) ? { value: null, upTo: false, resale: true } : null;
}
