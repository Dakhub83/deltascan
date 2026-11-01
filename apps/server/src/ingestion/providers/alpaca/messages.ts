// Wire format of Alpaca's v2 stock stream (JSON encoding).

export interface AlpacaTradeMsg {
  T: 't';
  S: string; // symbol
  i: number; // trade id
  x: string; // exchange code
  p: number; // price
  s: number; // size
  c?: string[]; // trade conditions
  t: string; // RFC-3339 timestamp, nanosecond precision
  z: string; // tape
}

export interface AlpacaQuoteMsg {
  T: 'q';
  S: string;
  bx: string;
  bp: number;
  bs: number;
  ax: string;
  ap: number;
  as: number;
  c?: string[];
  t: string;
  z: string;
}

export interface AlpacaBarMsg {
  T: 'b' | 'u';
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
  t: string;
}

/** Trading status (halts / resumptions). */
export interface AlpacaStatusMsg {
  T: 's';
  S: string;
  sc: string; // status code
  sm: string; // status message
  rc: string; // reason code
  rm: string; // reason message
  t: string;
  z: string;
}

export interface AlpacaSuccessMsg {
  T: 'success';
  msg: 'connected' | 'authenticated' | string;
}

export interface AlpacaErrorMsg {
  T: 'error';
  code: number;
  msg: string;
}

export interface AlpacaSubscriptionMsg {
  T: 'subscription';
  trades?: string[];
  quotes?: string[];
  bars?: string[];
}

export type AlpacaMessage =
  | AlpacaTradeMsg
  | AlpacaQuoteMsg
  | AlpacaBarMsg
  | AlpacaStatusMsg
  | AlpacaSuccessMsg
  | AlpacaErrorMsg
  | AlpacaSubscriptionMsg;

// CTA (2, 3, F…) and UTP (H, Q, T, P) status codes.
const HALTED_CODES = new Set(['H', 'P', '2', 'F']);
const QUOTING_CODES = new Set(['Q']);
const RESUMED_CODES = new Set(['T', '3']);

/** Maps an Alpaca status code to a halt state, or null for informational codes (imbalances etc.). */
export function haltStateOf(statusCode: string): 'halted' | 'quoting' | 'resumed' | null {
  if (HALTED_CODES.has(statusCode)) return 'halted';
  if (QUOTING_CODES.has(statusCode)) return 'quoting';
  if (RESUMED_CODES.has(statusCode)) return 'resumed';
  return null;
}

/** Parses RFC-3339 with up to nanosecond fractions into epoch ms (fraction truncated to ms). */
export function parseAlpacaTimestamp(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
}
