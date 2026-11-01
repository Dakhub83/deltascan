import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Alert, AlertType } from '@deltascan/shared';

// Loaded at runtime: Vite (vitest) doesn't know the `node:sqlite` builtin yet and strips the prefix.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface UserRow {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: number;
}

export interface LayoutMeta {
  name: string;
  updatedAt: number;
}

/** Each entry upgrades the schema by one version (PRAGMA user_version); never edit a shipped one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE watchlist (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );
  CREATE TABLE layouts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  );
  CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    change_pct REAL,
    detail TEXT NOT NULL,
    value REAL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX alerts_ts ON alerts(ts);
  CREATE INDEX alerts_symbol_ts ON alerts(symbol, ts);
  `,
];

/** Alerts older than this are deleted on startup; the table is a history, not an archive. */
const ALERT_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Users, sessions, watchlists, saved layouts and alert history, in one SQLite file. */
export class AppDb {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.db.prepare('DELETE FROM alerts WHERE ts < ?').run(Date.now() - ALERT_RETENTION_MS);
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Users ──

  createUser(email: string, passwordHash: string): UserRow {
    const createdAt = Date.now();
    const { lastInsertRowid } = this.db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(email, passwordHash, createdAt);
    return { id: Number(lastInsertRowid), email, passwordHash, createdAt };
  }

  userByEmail(email: string): UserRow | null {
    return this.toUser(this.db.prepare('SELECT * FROM users WHERE email = ?').get(email));
  }

  userById(id: number): UserRow | null {
    return this.toUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  /** Accounts that can sign in (the built-in local user has no password). */
  countUsersWithPassword(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash != ''").get() as { n: number }).n;
  }

  private toUser(row: unknown): UserRow | null {
    if (!row) return null;
    const r = row as { id: number; email: string; password_hash: string; created_at: number };
    return { id: r.id, email: r.email, passwordHash: r.password_hash, createdAt: r.created_at };
  }

  // ── Sessions ──

  createSession(tokenHash: string, userId: number, expiresAt: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, Date.now(), expiresAt);
  }

  sessionUser(tokenHash: string, now: number): UserRow | null {
    return this.toUser(
      this.db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(tokenHash, now),
    );
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  // ── Watchlist ──

  watchlist(userId: number): string[] {
    return (this.db.prepare('SELECT symbol FROM watchlist WHERE user_id = ? ORDER BY added_at').all(userId) as { symbol: string }[]).map((r) => r.symbol);
  }

  /** Every user's symbols: the server keeps them all in the feed. */
  allWatchlistSymbols(): string[] {
    return (this.db.prepare('SELECT DISTINCT symbol FROM watchlist').all() as { symbol: string }[]).map((r) => r.symbol);
  }

  addToWatchlist(userId: number, symbol: string): void {
    this.db.prepare('INSERT OR IGNORE INTO watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)').run(userId, symbol, Date.now());
  }

  removeFromWatchlist(userId: number, symbol: string): void {
    this.db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?').run(userId, symbol);
  }

  // ── Layouts ──

  layouts(userId: number): LayoutMeta[] {
    return (this.db.prepare('SELECT name, updated_at FROM layouts WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId) as { name: string; updated_at: number }[]).map(
      (r) => ({ name: r.name, updatedAt: r.updated_at }),
    );
  }

  layout(userId: number, name: string): string | null {
    const row = this.db.prepare('SELECT data FROM layouts WHERE user_id = ? AND name = ?').get(userId, name) as { data: string } | undefined;
    return row?.data ?? null;
  }

  saveLayout(userId: number, name: string, data: string): void {
    this.db
      .prepare('INSERT INTO layouts (user_id, name, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(userId, name, data, Date.now());
  }

  deleteLayout(userId: number, name: string): void {
    this.db.prepare('DELETE FROM layouts WHERE user_id = ? AND name = ?').run(userId, name);
  }

  // ── Alert history ──

  insertAlerts(alerts: readonly Alert[]): void {
    if (!alerts.length) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO alerts (id, type, symbol, price, change_pct, detail, value, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const a of alerts) insert.run(a.id, a.type, a.symbol, a.price, a.changePct, a.detail, a.value ?? null, a.timestamp);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Newest first. */
  alerts(opts: { since?: number; symbol?: string; limit: number }): Alert[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM alerts WHERE ts >= ? ${opts.symbol ? 'AND symbol = ?' : ''} ORDER BY ts DESC LIMIT ?`,
      )
      .all(...([opts.since ?? 0, ...(opts.symbol ? [opts.symbol] : []), opts.limit] as (string | number)[])) as {
      id: string;
      type: AlertType;
      symbol: string;
      price: number;
      change_pct: number | null;
      detail: string;
      value: number | null;
      ts: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      symbol: r.symbol,
      price: r.price,
      changePct: r.change_pct,
      detail: r.detail,
      ...(r.value !== null ? { value: r.value } : {}),
      timestamp: r.ts,
    }));
  }
}
