import { create } from 'zustand';
import type { SessionInfo } from '../lib/session';

interface SessionState {
  session: SessionInfo | null;
  setSession: (session: SessionInfo) => void;
}

/** Who is signed in, for the account menu. */
export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
}));
