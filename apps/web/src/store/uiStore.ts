import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AlertType, ProviderStatus, ServerStats } from '@deltascan/shared';

export type SocketState = 'connecting' | 'open' | 'closed';

export interface Settings {
  sound: boolean;
  volume: number;
  notifications: boolean;
  /** Alert types that play a sound / raise a desktop notification. */
  audibleTypes: AlertType[];
  flashCells: boolean;
}

interface UiState {
  socket: SocketState;
  provider: ProviderStatus | null;
  stats: ServerStats | null;
  lastMessageAt: number | null;
  selectedSymbol: string | null;
  settings: Settings;
  setSelectedSymbol: (symbol: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      socket: 'connecting',
      provider: null,
      stats: null,
      lastMessageAt: null,
      selectedSymbol: null,
      settings: {
        sound: true,
        volume: 0.5,
        notifications: false,
        audibleTypes: ['block_trade', 'volume_spike', 'new_high'],
        flashCells: true,
      },
      setSelectedSymbol: (selectedSymbol) => set({ selectedSymbol }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: 'deltascan.ui.v1',
      partialize: (s) => ({ settings: s.settings, selectedSymbol: s.selectedSymbol }),
    },
  ),
);
