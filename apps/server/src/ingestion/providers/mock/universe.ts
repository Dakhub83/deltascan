export type MockProfile = 'etf' | 'large' | 'mid' | 'micro';

export interface MockSymbol {
  symbol: string;
  name: string;
  sector: string;
  profile: MockProfile;
}

const s = (symbol: string, name: string, sector: string, profile: MockProfile): MockSymbol => ({
  symbol,
  name,
  sector,
  profile,
});

// Real large/mid caps for familiarity (prices are simulated), plus fictional micro caps
// to exercise low-float "runner" scans.
export const MOCK_UNIVERSE: MockSymbol[] = [
  s('SPY', 'SPDR S&P 500 ETF', 'ETF', 'etf'),
  s('QQQ', 'Invesco QQQ Trust', 'ETF', 'etf'),
  s('IWM', 'iShares Russell 2000 ETF', 'ETF', 'etf'),

  s('AAPL', 'Apple Inc.', 'Technology', 'large'),
  s('MSFT', 'Microsoft Corp.', 'Technology', 'large'),
  s('NVDA', 'NVIDIA Corp.', 'Semiconductors', 'large'),
  s('AMZN', 'Amazon.com Inc.', 'Consumer', 'large'),
  s('META', 'Meta Platforms Inc.', 'Communication', 'large'),
  s('GOOGL', 'Alphabet Inc.', 'Communication', 'large'),
  s('TSLA', 'Tesla Inc.', 'Automotive', 'large'),
  s('AMD', 'Advanced Micro Devices', 'Semiconductors', 'large'),
  s('NFLX', 'Netflix Inc.', 'Communication', 'large'),
  s('AVGO', 'Broadcom Inc.', 'Semiconductors', 'large'),
  s('JPM', 'JPMorgan Chase & Co.', 'Financials', 'large'),
  s('XOM', 'Exxon Mobil Corp.', 'Energy', 'large'),
  s('LLY', 'Eli Lilly & Co.', 'Healthcare', 'large'),
  s('COST', 'Costco Wholesale', 'Consumer', 'large'),
  s('BA', 'Boeing Co.', 'Industrials', 'large'),
  s('DIS', 'Walt Disney Co.', 'Communication', 'large'),
  s('INTC', 'Intel Corp.', 'Semiconductors', 'large'),
  s('CRM', 'Salesforce Inc.', 'Technology', 'large'),
  s('UBER', 'Uber Technologies', 'Technology', 'large'),
  s('COIN', 'Coinbase Global', 'Financials', 'large'),

  s('PLTR', 'Palantir Technologies', 'Technology', 'mid'),
  s('SOFI', 'SoFi Technologies', 'Financials', 'mid'),
  s('RIVN', 'Rivian Automotive', 'Automotive', 'mid'),
  s('HOOD', 'Robinhood Markets', 'Financials', 'mid'),
  s('MARA', 'MARA Holdings', 'Crypto', 'mid'),
  s('RIOT', 'Riot Platforms', 'Crypto', 'mid'),
  s('SMCI', 'Super Micro Computer', 'Technology', 'mid'),
  s('DKNG', 'DraftKings Inc.', 'Consumer', 'mid'),
  s('AFRM', 'Affirm Holdings', 'Financials', 'mid'),
  s('SNAP', 'Snap Inc.', 'Communication', 'mid'),
  s('ROKU', 'Roku Inc.', 'Communication', 'mid'),
  s('CVNA', 'Carvana Co.', 'Consumer', 'mid'),
  s('UPST', 'Upstart Holdings', 'Financials', 'mid'),
  s('IONQ', 'IonQ Inc.', 'Technology', 'mid'),
  s('RKLB', 'Rocket Lab USA', 'Industrials', 'mid'),
  s('LCID', 'Lucid Group', 'Automotive', 'mid'),
  s('NIO', 'NIO Inc.', 'Automotive', 'mid'),
  s('PLUG', 'Plug Power Inc.', 'Energy', 'mid'),

  s('QBTX', 'Qubitex Systems', 'Technology', 'micro'),
  s('HLXR', 'Helixar Robotics', 'Industrials', 'micro'),
  s('ZNTA', 'Zentara Therapeutics', 'Healthcare', 'micro'),
  s('MRVX', 'Marvex Mining', 'Materials', 'micro'),
  s('VYRE', 'Vyre Labs', 'Technology', 'micro'),
  s('KLDX', 'Kaldex Energy', 'Energy', 'micro'),
  s('ORBQ', 'OrbiQ Space', 'Industrials', 'micro'),
  s('NEXL', 'Nexlo Pharma', 'Healthcare', 'micro'),
  s('TRPZ', 'Tripz Media', 'Communication', 'micro'),
  s('GLYP', 'Glyph AI Corp.', 'Technology', 'micro'),
  s('BRKX', 'Brikx Materials', 'Materials', 'micro'),
  s('FUZN', 'Fuzion Bio', 'Healthcare', 'micro'),
  s('XRTA', 'Xerta Genomics', 'Healthcare', 'micro'),
  s('CYNQ', 'Cynq Health', 'Healthcare', 'micro'),
  s('LUMQ', 'Lumiq Optics', 'Technology', 'micro'),
];
