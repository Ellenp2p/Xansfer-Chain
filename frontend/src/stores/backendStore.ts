import { create } from 'zustand'

interface BackendState {
  online: boolean
  checking: boolean
  lastCheckedAt: number | null
  offlineChecks: number
  setOnline: (online: boolean) => void
  setChecking: (checking: boolean) => void
  markCheck: (online: boolean) => void
}

export const useBackendStore = create<BackendState>((set) => ({
  online: true,
  checking: false,
  lastCheckedAt: null,
  offlineChecks: 0,
  setOnline: (online) => set({ online }),
  setChecking: (checking) => set({ checking }),
  markCheck: (online) =>
    set((s) => ({
      online,
      lastCheckedAt: Date.now(),
      checking: false,
      offlineChecks: online ? 0 : s.offlineChecks + 1,
    })),
}))
