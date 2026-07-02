import { create } from 'zustand'
import type { TransferType } from '../types'

interface TransferFormState {
  sourceDomain: number | null
  destDomain: number | null
  amount: string
  transferType: TransferType
  useRelay: boolean
  destAddress: string
  setSourceDomain: (d: number) => void
  setDestDomain: (d: number) => void
  setAmount: (a: string) => void
  setTransferType: (t: TransferType) => void
  setUseRelay: (v: boolean) => void
  setDestAddress: (a: string) => void
  reset: () => void
}

export const useTransferStore = create<TransferFormState>((set) => ({
  sourceDomain: null,
  destDomain: null,
  amount: '',
  transferType: 'standard',
  useRelay: false,
  destAddress: '',
  setSourceDomain: (d) => set({ sourceDomain: d }),
  setDestDomain: (d) => set({ destDomain: d }),
  setAmount: (a) => set({ amount: a }),
  setTransferType: (t) => set({ transferType: t, useRelay: t === 'relay' }),
  setUseRelay: (v) => set({ useRelay: v }),
  setDestAddress: (a) => set({ destAddress: a }),
  reset: () =>
    set({
      sourceDomain: null,
      destDomain: null,
      amount: '',
      transferType: 'standard',
      useRelay: false,
      destAddress: '',
    }),
}))
