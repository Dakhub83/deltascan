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
  | AlpacaSuccessMsg
  | AlpacaErrorMsg
  | AlpacaSubscriptionMsg;

/** Parses RFC-3339 with up to nanosecond fractions into epoch ms (fraction truncated to ms). */
export function parseAlpacaTimestamp(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
}
