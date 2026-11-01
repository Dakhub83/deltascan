import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import type { AppDb, UserRow } from '../db/AppDb';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'ds_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 8;
/** Without AUTH_REQUIRED every request acts as this account, so watchlists and layouts still persist. */
export const LOCAL_EMAIL = 'local@deltascan.local';

export interface PublicUser {
  id: number;
  email: string;
}

export interface AuthOptions {
  /** Every page, API call and the data socket need a signed-in user. */
  required: boolean;
  /** Anyone may create an account. The first account can always be created. */
  allowSignup: boolean;
  /** Mark the cookie Secure (the site is served over HTTPS). */
  secureCookie: boolean;
}

/** "scrypt$<salt hex>$<key hex>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(key, expected);
}

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const isValidEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** Failed sign-ins per client address; a guesser is locked out for the rest of the window. */
class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  blocked(key: string, now: number): boolean {
    const a = this.attempts.get(key);
    if (a && a.resetAt <= now) this.attempts.delete(key);
    return (this.attempts.get(key)?.count ?? 0) >= this.max;
  }

  fail(key: string, now: number): void {
    const a = this.attempts.get(key);
    if (!a || a.resetAt <= now) this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    else a.count++;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

export type AuthResult = { ok: true; user: PublicUser; cookie: string } | { ok: false; status: number; error: string };

export class Auth {
  private readonly limiter = new AttemptLimiter(10, 15 * 60_000);
  private localUser: UserRow | null = null;

  constructor(private readonly db: AppDb, readonly opts: AuthOptions) {}

  /** Signup is open by setting, or because no one can sign in yet (the first account). */
  get signupOpen(): boolean {
    return this.opts.allowSignup || this.db.countUsersWithPassword() === 0;
  }

  /** The signed-in user, or the local account when sign-in isn't required. Null = not allowed. */
  userFor(req: IncomingMessage): PublicUser | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token ? this.db.sessionUser(sha256(token), Date.now()) : null;
    if (user) return { id: user.id, email: user.email };
    return this.opts.required ? null : this.local();
  }

  /** The signed-in user only (never the local fallback): what `/api/auth/me` reports. */
  signedIn(req: IncomingMessage): PublicUser | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token ? this.db.sessionUser(sha256(token), Date.now()) : null;
    return user ? { id: user.id, email: user.email } : null;
  }

  private local(): PublicUser {
    this.localUser ??= this.db.userByEmail(LOCAL_EMAIL) ?? this.db.createUser(LOCAL_EMAIL, '');
    return { id: this.localUser.id, email: this.localUser.email };
  }

  async signup(emailRaw: unknown, password: unknown): Promise<AuthResult> {
    if (!this.signupOpen) return { ok: false, status: 403, error: 'Sign-up is closed. Ask the owner for an account.' };
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
    if (!isValidEmail(email) || email === LOCAL_EMAIL) return { ok: false, status: 400, error: 'Enter a valid email address.' };
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      return { ok: false, status: 400, error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    if (this.db.userByEmail(email)) return { ok: false, status: 409, error: 'An account with this email already exists.' };
    const user = this.db.createUser(email, await hashPassword(password));
    return { ok: true, user: { id: user.id, email: user.email }, cookie: this.startSession(user.id) };
  }

  async login(emailRaw: unknown, password: unknown, clientKey: string): Promise<AuthResult> {
    const now = Date.now();
    if (this.limiter.blocked(clientKey, now)) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
    const user = email && email !== LOCAL_EMAIL ? this.db.userByEmail(email) : null;
    const ok = !!user && typeof password === 'string' && (await verifyPassword(password, user.passwordHash));
    if (!ok || !user) {
      this.limiter.fail(clientKey, now);
      return { ok: false, status: 401, error: 'Wrong email or password.' };
    }
    this.limiter.clear(clientKey);
    this.db.deleteExpiredSessions(now);
    return { ok: true, user: { id: user.id, email: user.email }, cookie: this.startSession(user.id) };
  }

  /** The Set-Cookie value that ends the session. */
  logout(req: IncomingMessage): string {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) this.db.deleteSession(sha256(token));
    return this.cookie('', 0);
  }

  private startSession(userId: number): string {
    const token = randomBytes(32).toString('base64url');
    this.db.createSession(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    return this.cookie(token, SESSION_TTL_MS / 1000);
  }

  private cookie(value: string, maxAgeSec: number): string {
    return [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeSec)}`,
      ...(this.opts.secureCookie ? ['Secure'] : []),
    ].join('; ');
  }
}
