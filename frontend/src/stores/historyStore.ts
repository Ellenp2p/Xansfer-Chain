import { create } from 'zustand'
import type { Transaction } from '../types'
import * as api from '../lib/api'
import type { Mode } from '../config/chains'

interface HistoryState {
  transactions: Transaction[]
  loading: boolean
  error: string | null
  fetchTransactions: (addresses: string[], mode: Mode) => Promise<void>
}

export const useHistoryStore = create<HistoryState>((set) => ({
  transactions: [],
  loading: false,
  error: null,
  fetchTransactions: async (addresses, mode) => {
    const unique = [...new Set(addresses.filter(Boolean))]
    if (unique.length === 0) {
      set({ transactions: [], loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const { transactions } = await api.listTransactions(unique, mode)
      set({ transactions, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load', loading: false })
    }
  },
}))
