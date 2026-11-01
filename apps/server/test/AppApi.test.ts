import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import WebSocket from 'ws';
import type { Alert } from '@deltascan/shared';
import { AppDb } from '../src/db/AppDb';
import { Auth, hashPassword, verifyPassword, type AuthOptions } from '../src/auth/Auth';
import { handleAppApi } from '../src/gateway/AppApi';
import { ClientGateway } from '../src/gateway/ClientGateway';
import { SymbolStore } from '../src/cache/SymbolStore';
import { AlertEngine } from '../src/scanner/AlertEngine';
import { HaltTracker } from '../src/scanner/HaltTracker';

const alert = (id: string, symbol: string, ts: number): Alert => ({ id, type: 'new_high', symbol, price: 2, detail: 'x', changePct: 10, timestamp: ts });

describe('AppDb', () => {
  it('keeps watchlists, layouts and alert history per user', () => {
    const db = new AppDb(':memory:');
    const a = db.createUser('a@x.io', 'h');
    const b = db.createUser('b@x.io', 'h');
    db.addToWatchlist(a.id, 'RUN');
    db.addToWatchlist(a.id, 'RUN');
    db.addToWatchlist(b.id, 'GAP');
    expect(db.watchlist(a.id)).toEqual(['RUN']);
    expect(db.allWatchlistSymbols().sort()).toEqual(['GAP', 'RUN']);

    db.saveLayout(a.id, 'Morning', '{"v":1}');
    db.saveLayout(a.id, 'Morning', '{"v":2}');
    expect(db.layouts(a.id).map((l) => l.name)).toEqual(['Morning']);
    expect(db.layout(a.id, 'Morning')).toBe('{"v":2}');
    expect(db.layout(b.id, 'Morning')).toBeNull();

    db.insertAlerts([alert('1', 'RUN', 1_000), alert('2', 'GAP', 2_000), alert('2', 'GAP', 2_000)]);
    expect(db.alerts({ limit: 10 }).map((x) => x.id)).toEqual(['2', '1']);
    expect(db.alerts({ symbol: 'RUN', limit: 10 })).toEqual([alert('1', 'RUN', 1_000)]);
  });

  it('migrates a file once and reopens it with the data intact', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ds-')), 'nested', 'app.db');
    const first = new AppDb(path);
    first.createUser('a@x.io', 'h');
    first.close();
    const again = new AppDb(path);
    expect(again.userByEmail('A@X.IO')?.email).toBe('a@x.io'); // emails match case-insensitively
    again.close();
  });
});

describe('AlertEngine.restore', () => {
  it('reloads the feed newest first and resumes cooldowns from it', () => {
    const engine = new AlertEngine();
    const now = Date.now();
    engine.restore([alert('2', 'RUN', now - 1_000), alert('1', 'RUN', now - 120_000)]);
    expect(engine.recent().map((a) => a.id)).toEqual(['2', '1']);
    expect(engine.drain()).toEqual([]); // nothing re-sent as new
    // A new high 10 s after the restored one is still inside the 60 s cooldown.
    engine.raise('new_high', { symbol: 'RUN', price: 3, timestamp: now + 9_000 }, 20, 'again');
    expect(engine.drain()).toEqual([]);
  });
});

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const [h1, h2] = [await hashPassword('correct horse'), await hashPassword('correct horse')];
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('correct horse', h1)).toBe(true);
    expect(await verifyPassword('wrong horse', h1)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('account API', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  async function start(opts: Partial<AuthOptions> = {}) {
    const db = new AppDb(':memory:');
    const auth = new Auth(db, { required: true, allowSignup: false, secureCookie: false, ...opts });
    const watched: string[] = [];
    server = createServer((req, res) => {
      void handleAppApi(req, res, new URL(req.url!, 'http://x'), { auth, db, onWatch: (s) => watched.push(s), trustProxy: false }).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown, contentType = 'application/json') => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': contentType } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[], setCookie: set };
    };
    return { call, db, watched, signOut: () => (cookie = '') };
  }

  it('lets the first account sign up, then closes sign-up', async () => {
    const { call, signOut } = await start();
    expect((await call('GET', '/api/auth/me')).body).toEqual({ user: null, authRequired: true, signupOpen: true });
    const first = await call('POST', '/api/auth/signup', { email: ' Me@Example.com ', password: 'longenough' });
    expect(first.status).toBe(200);
    expect(first.setCookie).toMatch(/^ds_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect((await call('GET', '/api/auth/me')).body.user).toMatchObject({ email: 'me@example.com' });
    signOut();
    expect((await call('POST', '/api/auth/signup', { email: 'other@example.com', password: 'longenough' })).status).toBe(403);
  });

  it('rejects bad sign-ups, wrong passwords, and locks out a guesser', async () => {
    const { call } = await start({ allowSignup: true });
    expect((await call('POST', '/api/auth/signup', { email: 'nope', password: 'longenough' })).status).toBe(400);
    expect((await call('POST', '/api/auth/signup', { email: 'a@b.co', password: 'short' })).status).toBe(400);
    expect((await call('POST', '/api/auth/signup', { email: 'a@b.co', password: 'longenough' })).status).toBe(200);
    expect((await call('POST', '/api/auth/signup', { email: 'A@b.co', password: 'longenough' })).status).toBe(409);
    expect((await call('POST', '/api/auth/login', { email: 'a@b.co', password: 'longenough' })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await call('POST', '/api/auth/login', { email: 'a@b.co', password: 'wrong-guess' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { email: 'a@b.co', password: 'longenough' })).status).toBe(429);
  });

  it('guards the data behind the session and ends it on sign-out', async () => {
    const { call, watched } = await start();
    expect((await call('GET', '/api/watchlist')).status).toBe(401);
    await call('POST', '/api/auth/signup', { email: 'me@x.io', password: 'longenough' });
    expect((await call('POST', '/api/watchlist', { symbol: 'run' })).body).toEqual(['RUN']);
    expect(watched).toEqual(['RUN']);
    expect((await call('POST', '/api/watchlist', { symbol: '../etc' })).status).toBe(400);
    // A plain form post can't reach the API (no CORS preflight for JSON from another site).
    expect((await call('POST', '/api/watchlist', 'symbol=GAP', 'application/x-www-form-urlencoded')).status).toBe(415);

    expect((await call('PUT', '/api/layouts/Morning%20fades', { app: 'DeltaScan', layout: { grid: {} } })).body).toEqual([
      { name: 'Morning fades', updatedAt: expect.any(Number) },
    ]);
    expect((await call('GET', '/api/layouts/Morning%20fades')).body).toEqual({ app: 'DeltaScan', layout: { grid: {} } });

    const out = await call('POST', '/api/auth/logout', {});
    expect(out.setCookie).toMatch(/^ds_session=; .*Max-Age=0/);
    expect((await call('GET', '/api/watchlist')).status).toBe(401);
  });

  it('without required sign-in, acts as the built-in local account', async () => {
    const { call } = await start({ required: false });
    expect((await call('POST', '/api/watchlist', { symbol: 'RUN' })).body).toEqual(['RUN']);
    expect((await call('GET', '/api/auth/me')).body).toMatchObject({ user: null, authRequired: false });
    // The local account has no password: it can't be signed into.
    expect((await call('POST', '/api/auth/login', { email: 'local@deltascan.local', password: '' })).status).toBe(401);
  });
});

describe('ClientGateway with sign-in required', () => {
  let gateway: ClientGateway | null = null;
  afterEach(() => gateway?.stop());

  it('refuses the data socket and data API without a session, and serves the built site safely', async () => {
    const db = new AppDb(':memory:');
    const auth = new Auth(db, { required: true, allowSignup: false, secureCookie: false });
    const outside = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    const web = join(outside, 'site');
    mkdirSync(join(web, 'app'), { recursive: true });
    writeFileSync(join(web, 'index.html'), 'landing');
    writeFileSync(join(web, 'app', 'index.html'), 'dashboard');
    const port = 41_000 + Math.floor(Math.random() * 2_000);
    gateway = new ClientGateway({
      port,
      broadcastIntervalMs: 1_000,
      store: new SymbolStore(),
      alerts: new AlertEngine(),
      halts: new HaltTracker(),
      getStatus: () => null,
      getStats: () => ({ symbols: 0, tradesPerSec: 0, quotesPerSec: 0, session: 'regular' }),
      getSession: () => 'regular',
      app: { auth, db, onWatch: () => {}, trustProxy: false },
      webRoot: web,
      logger: pino({ level: 'silent' }),
    });
    gateway.start();
    await new Promise((r) => setTimeout(r, 100));
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/api/bars?symbol=RUN`)).status).toBe(401);
    const refused = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('open', () => resolve('open'));
      ws.on('error', (err) => resolve(err.message));
    });
    expect(refused).toMatch(/401/);

    expect(await (await fetch(`${base}/`)).text()).toBe('landing');
    expect(await (await fetch(`${base}/app/`)).text()).toBe('dashboard');
    expect(await (await fetch(`${base}/app/anything`)).text()).toBe('dashboard');
    expect((await fetch(`${base}/app`, { redirect: 'manual' })).headers.get('location')).toBe('/app/');
    expect((await fetch(`${base}/..%2fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/`)).headers.get('x-content-type-options')).toBe('nosniff');
  });
});
