import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Alert } from '@deltascan/shared';
import type { Auth, PublicUser } from '../auth/Auth';
import type { AppDb } from '../db/AppDb';

export interface AppApiOptions {
  auth: Auth;
  db: AppDb;
  /** A symbol was added to someone's watchlist: keep it in the feed. */
  onWatch: (symbol: string) => void;
  /** Behind a reverse proxy (Caddy, nginx): the client address comes from X-Forwarded-For. */
  trustProxy: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024; // a saved layout is a few KB; this is generous
const MAX_WATCHLIST = 200;
const MAX_LAYOUTS = 100;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const LAYOUT_NAME = /^[^\u0000-\u001f]{1,80}$/;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // A cross-site form can't send this content type without a CORS preflight, which never passes.
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new HttpError(400, 'Invalid JSON');
}

/** Only a trusted proxy's X-Forwarded-For counts: a client could otherwise dodge the sign-in limit. */
const clientKey = (req: IncomingMessage, trustProxy: boolean) =>
  (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim()) || req.socket.remoteAddress || '?';

/**
 * Accounts, watchlists, saved layouts and alert history. Returns false for paths it doesn't own.
 * Everything except sign-in needs a user (the local account when sign-in isn't required).
 */
export async function handleAppApi(req: IncomingMessage, res: ServerResponse, url: URL, opts: AppApiOptions): Promise<boolean> {
  const { auth, db } = opts;
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/auth/') && !path.startsWith('/api/watchlist') && !path.startsWith('/api/layouts') && path !== '/api/alerts/history') return false;

  try {
    // ── Accounts ──
    if (path === '/api/auth/me' && method === 'GET') {
      sendJson(res, 200, { user: auth.signedIn(req), authRequired: auth.opts.required, signupOpen: auth.signupOpen });
      return true;
    }
    if ((path === '/api/auth/login' || path === '/api/auth/signup') && method === 'POST') {
      const body = await readJson(req);
      const result = path === '/api/auth/login' ? await auth.login(body.email, body.password, clientKey(req, opts.trustProxy)) : await auth.signup(body.email, body.password);
      if (result.ok) sendJson(res, 200, { user: result.user }, { 'set-cookie': result.cookie });
      else sendJson(res, result.status, { error: result.error });
      return true;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      sendJson(res, 200, { ok: true }, { 'set-cookie': auth.logout(req) });
      return true;
    }

    const user = auth.userFor(req);
    if (!user) throw new HttpError(401, 'Sign in first');

    if (path === '/api/watchlist') return await watchlist(req, res, url, method, user, opts);
    if (path === '/api/layouts' || path.startsWith('/api/layouts/')) return await layouts(req, res, path, method, user, db);
    if (path === '/api/alerts/history' && method === 'GET') {
      const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
      if (symbol && !SYMBOL.test(symbol)) throw new HttpError(400, 'Invalid symbol');
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
      sendJson(res, 200, db.alerts({ since, symbol: symbol || undefined, limit }) satisfies Alert[]);
      return true;
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: 'Server error' });
    if (!(err instanceof HttpError)) throw err;
    return true;
  }
}

async function watchlist(req: IncomingMessage, res: ServerResponse, url: URL, method: string, user: PublicUser, opts: AppApiOptions): Promise<boolean> {
  const { db } = opts;
  if (method === 'GET') {
    sendJson(res, 200, db.watchlist(user.id));
    return true;
  }
  if (method === 'POST') {
    const symbol = String((await readJson(req)).symbol ?? '').trim().toUpperCase();
    if (!SYMBOL.test(symbol)) throw new HttpError(400, 'Invalid symbol');
    const list = db.watchlist(user.id);
    if (!list.includes(symbol) && list.length >= MAX_WATCHLIST) throw new HttpError(400, `A watchlist holds up to ${MAX_WATCHLIST} symbols`);
    db.addToWatchlist(user.id, symbol);
    opts.onWatch(symbol);
    sendJson(res, 200, db.watchlist(user.id));
    return true;
  }
  if (method === 'DELETE') {
    db.removeFromWatchlist(user.id, (url.searchParams.get('symbol') ?? '').toUpperCase());
    sendJson(res, 200, db.watchlist(user.id));
    return true;
  }
  throw new HttpError(405, 'Method not allowed');
}

async function layouts(req: IncomingMessage, res: ServerResponse, path: string, method: string, user: PublicUser, db: AppDb): Promise<boolean> {
  if (path === '/api/layouts') {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
    sendJson(res, 200, db.layouts(user.id));
    return true;
  }
  let name: string;
  try {
    name = decodeURIComponent(path.slice('/api/layouts/'.length));
  } catch {
    throw new HttpError(400, 'Invalid layout name');
  }
  if (!LAYOUT_NAME.test(name)) throw new HttpError(400, 'Invalid layout name');
  if (method === 'GET') {
    const data = db.layout(user.id, name);
    if (data === null) throw new HttpError(404, 'No such layout');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(data);
    return true;
  }
  if (method === 'PUT') {
    const body = await readJson(req);
    const exists = db.layout(user.id, name) !== null;
    if (!exists && db.layouts(user.id).length >= MAX_LAYOUTS) throw new HttpError(400, `Up to ${MAX_LAYOUTS} saved layouts`);
    db.saveLayout(user.id, name, JSON.stringify(body));
    sendJson(res, 200, db.layouts(user.id));
    return true;
  }
  if (method === 'DELETE') {
    db.deleteLayout(user.id, name);
    sendJson(res, 200, db.layouts(user.id));
    return true;
  }
  throw new HttpError(405, 'Method not allowed');
}
