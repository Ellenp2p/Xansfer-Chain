/**
 * Core types for @xansfer/wallet-connect.
 *
 * These are deliberately self-contained (no imports from any app) so the
 * package can be published and reused independently.
 */

export type ChainType = 'evm' | 'stellar' | 'solana' | 'starknet' | 'aptos' | 'sui'

/** Chain types that have a wallet adapter (starknet has no wallet integration yet). */
export type ConnectedChainType = Exclude<ChainType, 'starknet'>

export const ALL_CHAIN_TYPES: ConnectedChainType[] = ['evm', 'solana', 'aptos', 'sui', 'stellar']

export interface ChainConfig {
  domain: number
  name: string
  chain_id: number | null
  rpc_url: string
  explorer_url: string
  usdc_address: string
  /** Stellar Asset Contract (SAC) address. Required for chain_type=stellar. */
  usdc_sac?: string
  token_messenger_v2: string
  message_transmitter_v2: string
  token_messenger_v1?: string
  message_transmitter_v1?: string
  cctp_versions?: number[]
  chain_type: ChainType
  supports_fast_transfer: boolean
  supports_forwarding: boolean
  block_time_ms: number
  finality_blocks: number
}

export interface WalletInfo {
  address: string
  chainId?: number
  chainType: ChainType
  domain?: number
}

/** Per-chain connection status. */
export interface WalletSlot {
  wallet: WalletInfo | null
  connecting: boolean
  error: string | null
}

/** Aggregate wallet state exposed by useWallet(). */
export interface WalletState {
  evm: WalletInfo | null
  solana: WalletInfo | null
  aptos: WalletInfo | null
  sui: WalletInfo | null
  stellar: WalletInfo | null
  /** Derive "active" wallet (first connected, in a stable order). */
  connected: boolean
  address: string
  chainType: ChainType | null
  totalConnected: number
}

/** A selectable wallet for a chain (e.g. MetaMask, Petra, Phantom). */
export interface WalletOption {
  id: string
  name: string
  icon?: string
}

/** Actions exposed for a single chain. Implemented by each chain adapter. */
export interface ChainActions {
  chainType: ChainType
  /** Wallets available for this chain. */
  wallets: WalletOption[]
  /** EVM uses connectorId to pick among injected/coinbase; other chains ignore it. */
  connect: (walletId?: string) => Promise<WalletInfo | null>
  disconnect: () => Promise<void>
  getAddress: () => string | null
}

export type WalletActions = Record<ConnectedChainType, ChainActions>

export type WalletSlots = Record<ConnectedChainType, WalletSlot>

export function emptyWalletState(): WalletState {
  return {
    evm: null,
    solana: null,
    aptos: null,
    sui: null,
    stellar: null,
    connected: false,
    address: '',
    chainType: null,
    totalConnected: 0,
  }
}
