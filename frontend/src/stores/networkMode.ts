import { create } from 'zustand'
import { modeFromPath } from '../config/chains'

export type NetworkMode = 'mainnet' | 'testnet'

const initialMode: NetworkMode =
  typeof window !== 'undefined' ? modeFromPath(window.location.pathname) : 'mainnet'

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
