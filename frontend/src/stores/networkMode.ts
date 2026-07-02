import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type NetworkMode = 'mainnet' | 'testnet'

interface NetworkModeState {
  mode: NetworkMode
  setMode: (mode: NetworkMode) => void
  toggleMode: () => void
}

export const useNetworkMode = create<NetworkModeState>()(
  persist(
    (set) => ({
      mode: 'mainnet',
      setMode: (mode) => set({ mode }),
      toggleMode: () => set((s) => ({ mode: s.mode === 'mainnet' ? 'testnet' : 'mainnet' })),
    }),
    { name: 'xansfer-network-mode' },
  ),
)

export function isTestnet(): boolean {
  return useNetworkMode.getState().mode === 'testnet'
}
