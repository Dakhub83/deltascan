import { create } from 'zustand';

interface WatchlistState {
  symbols: string[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  add: (symbol: string) => Promise<boolean>;
  remove: (symbol: string) => Promise<void>;
}

async function call(method: string, url: string, body?: unknown): Promise<string[]> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as string[] | { error?: string };
  if (!res.ok || !Array.isArray(data)) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data;
}

/** The account's watchlist, saved on the server (every device sees the same list). */
export const useWatchlistStore = create<WatchlistState>((set) => ({
  symbols: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      set({ symbols: await call('GET', '/api/watchlist'), loaded: true, error: null });
    } catch (err) {
      set({ loaded: true, error: (err as Error).message });
    }
  },
  add: async (symbol) => {
    try {
      set({ symbols: await call('POST', '/api/watchlist', { symbol }), error: null });
      return true;
    } catch (err) {
      set({ error: (err as Error).message });
      return false;
    }
  },
  remove: async (symbol) => {
    set((s) => ({ symbols: s.symbols.filter((x) => x !== symbol) }));
    try {
      set({ symbols: await call('DELETE', `/api/watchlist?symbol=${encodeURIComponent(symbol)}`), error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));
