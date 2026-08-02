import { create } from 'zustand'
import type { TransferType } from '../types'

interface TransferFormState {
  sourceDomain: number | null
  destDomain: number | null
  amount: string
  transferType: TransferType
  destAddress: string
  setSourceDomain: (d: number | null) => void
  setDestDomain: (d: number | null) => void
  setAmount: (a: string) => void
  setTransferType: (t: TransferType) => void
  setDestAddress: (a: string) => void
  reset: () => void
}

export const useTransferStore = create<TransferFormState>((set) => ({
  sourceDomain: null,
  destDomain: null,
  amount: '',
  transferType: 'standard',
  destAddress: '',
  setSourceDomain: (d) => set({ sourceDomain: d }),
  setDestDomain: (d) => set({ destDomain: d }),
  setAmount: (a) => set({ amount: a }),
  setTransferType: (t) => set({ transferType: t }),
  setDestAddress: (a) => set({ destAddress: a }),
  reset: () =>
    set({
      sourceDomain: null,
      destDomain: null,
      amount: '',
      transferType: 'standard',
      destAddress: '',
    }),
}))
