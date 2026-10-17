import { create } from 'zustand'
import { modeFromPath } from '../config/chains'

export type NetworkMode = 'mainnet' | 'testnet'

// HashRouter keeps the app route in location.hash (`#/mainnet/tx/…`), so the
// initial mode must come from the hash, not pathname.
const initialMode: NetworkMode =
  typeof window !== 'undefined' ? modeFromPath(window.location.hash.replace(/^#/, '')) : 'mainnet'

interface NetworkModeState {
  mode: NetworkMode
  setMode: (mode: NetworkMode) => void
}

export const useNetworkMode = create<NetworkModeState>()(
  (set) => ({
    mode: initialMode,
    setMode: (mode) => set({ mode }),
  }),
)

export function isTestnet(): boolean {
  return useNetworkMode.getState().mode === 'testnet'
}
