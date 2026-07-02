import { create } from 'zustand'
import type { ChainType } from '../types'
import { getDomainForChainId } from '../config/wagmi'

export interface WalletInfo {
  address: string
  chainId?: number
  chainType: ChainType
  domain?: number
}

interface WalletState {
  evm: WalletInfo | null
  solana: WalletInfo | null
  stellar: WalletInfo | null
  aptos: WalletInfo | null
  sui: WalletInfo | null

  // Derived — backward compatible with TransferForm/TransactionHistory
  connected: boolean
  address: string
  chainType: ChainType | null

  setEvmWallet: (wallet: WalletInfo | null) => void
  setSolanaWallet: (wallet: WalletInfo | null) => void
  setStellarWallet: (wallet: WalletInfo | null) => void
  setAptosWallet: (wallet: WalletInfo | null) => void
  setSuiWallet: (wallet: WalletInfo | null) => void
  getActiveWallet: () => WalletInfo | null
  disconnectAll: () => void
}

function deriveActive(
  evm: WalletInfo | null,
  solana: WalletInfo | null,
  stellar: WalletInfo | null,
  aptos: WalletInfo | null,
  sui: WalletInfo | null,
) {
  const active = evm ?? solana ?? aptos ?? sui ?? stellar
  return {
    connected: !!active,
    address: active?.address ?? '',
    chainType: active?.chainType ?? null,
  }
}

export const useWalletStore = create<WalletState>((set, get) => ({
  evm: null,
  solana: null,
  stellar: null,
  aptos: null,
  sui: null,
  connected: false,
  address: '',
  chainType: null,

  setEvmWallet: (wallet) =>
    set((s) => {
      const evm = wallet
      return { evm, ...deriveActive(evm, s.solana, s.stellar, s.aptos, s.sui) }
    }),

  setSolanaWallet: (wallet) =>
    set((s) => {
      const solana = wallet
      return { solana, ...deriveActive(s.evm, solana, s.stellar, s.aptos, s.sui) }
    }),

  setStellarWallet: (wallet) =>
    set((s) => {
      const stellar = wallet
      return { stellar, ...deriveActive(s.evm, s.solana, stellar, s.aptos, s.sui) }
    }),

  setAptosWallet: (wallet) =>
    set((s) => {
      const aptos = wallet
      return { aptos, ...deriveActive(s.evm, s.solana, s.stellar, aptos, s.sui) }
    }),

  setSuiWallet: (wallet) =>
    set((s) => {
      const sui = wallet
      return { sui, ...deriveActive(s.evm, s.solana, s.stellar, s.aptos, sui) }
    }),

  getActiveWallet: () => {
    const s = get()
    return s.evm ?? s.solana ?? s.aptos ?? s.sui ?? s.stellar
  },

  disconnectAll: () =>
    set({
      evm: null,
      solana: null,
      stellar: null,
      aptos: null,
      sui: null,
      connected: false,
      address: '',
      chainType: null,
    }),
}))

// Re-export chain helpers for backward compat
export { getDomainForChainId }
