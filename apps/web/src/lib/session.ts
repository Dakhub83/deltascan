export interface SessionUser {
  id: number;
  email: string;
}

export interface SessionInfo {
  /** The signed-in account; null when signed out or when sign-in isn't required. */
  user: SessionUser | null;
  authRequired: boolean;
  signupOpen: boolean;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export async function fetchSession(): Promise<SessionInfo> {
  const res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  return (await res.json()) as SessionInfo;
}

export const signIn = (email: string, password: string) => post<{ user: SessionUser }>('/api/auth/login', { email, password });
export const signUp = (email: string, password: string) => post<{ user: SessionUser }>('/api/auth/signup', { email, password });
export const signOut = () => post<{ ok: true }>('/api/auth/logout', {});
