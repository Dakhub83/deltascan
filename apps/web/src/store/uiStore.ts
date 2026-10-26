import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AlertType, MarketSession, ProviderStatus, ServerStats } from '@deltascan/shared';
import { DEFAULT_SHORT_LIMITS, type ShortLimits } from '../lib/shortPlan';

export type SocketState = 'connecting' | 'open' | 'closed';

export interface Settings {
  sound: boolean;
  volume: number;
  notifications: boolean;
  /** Alert types that play a sound / raise a desktop notification. */
  audibleTypes: AlertType[];
  flashCells: boolean;
  shortLimits: ShortLimits;
  /** False until the trader saves their own limits; the calculator nags until then. */
  shortLimitsSet: boolean;
}

interface UiState {
  socket: SocketState;
  provider: ProviderStatus | null;
  stats: ServerStats | null;
  /** Session reported by the server (simulated on the mock feed); null until connected. */
  session: MarketSession | null;
  lastMessageAt: number | null;
  selectedSymbol: string | null;
  settings: Settings;
  /** A one-line message shown under the top bar until dismissed. */
  notice: string | null;
  showNotice: (notice: string | null) => void;
  setSelectedSymbol: (symbol: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      socket: 'connecting',
      provider: null,
      stats: null,
      session: null,
      lastMessageAt: null,
      selectedSymbol: null,
      settings: {
        sound: true,
        volume: 0.5,
        notifications: false,
        audibleTypes: ['block_trade', 'volume_spike', 'new_high'],
        flashCells: true,
        shortLimits: DEFAULT_SHORT_LIMITS,
        shortLimitsSet: false,
      },
      notice: null,
      showNotice: (notice) => set({ notice }),
      setSelectedSymbol: (selectedSymbol) => set({ selectedSymbol }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: 'deltascan.ui.v1',
      partialize: (s) => ({ settings: s.settings, selectedSymbol: s.selectedSymbol }),
      // Saved settings from older versions lack newer keys; layer them over the defaults.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UiState>;
        return {
          ...current,
          ...saved,
          settings: {
            ...current.settings,
            ...saved.settings,
            shortLimits: { ...current.settings.shortLimits, ...saved.settings?.shortLimits },
          },
        };
      },
    },
  ),
);
