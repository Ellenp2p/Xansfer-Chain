import { create } from 'zustand'
import type { Transaction } from '../types'
import * as api from '../lib/api'

interface HistoryState {
  transactions: Transaction[]
  loading: boolean
  error: string | null
  fetchTransactions: (address: string) => Promise<void>
}

export const useHistoryStore = create<HistoryState>((set) => ({
  transactions: [],
  loading: false,
  error: null,
  fetchTransactions: async (address) => {
    set({ loading: true, error: null })
    try {
      const { transactions } = await api.listTransactions(address)
      set({ transactions, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load', loading: false })
    }
  },
}))
