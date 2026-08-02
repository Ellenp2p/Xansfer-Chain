import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Config } from 'wagmi'
import {
  ALL_CHAIN_TYPES,
  type ChainActions,
  type ChainConfig,
  type ConnectedChainType,
  type WalletActions,
  type WalletInfo,
  type WalletSlot,
  type WalletSlots,
  type WalletState,
} from '../core/types'
import { EvmAdapter } from '../adapters/evm'
import { SolanaAdapter } from '../adapters/solana'
import { AptosAdapter } from '../adapters/aptos'
import { SuiAdapter } from '../adapters/sui'
import { StellarAdapter } from '../adapters/stellar'

export interface WalletContextValue {
  state: WalletState
  /** Per-chain connection slots (wallet, connecting, error). */
  slots: WalletSlots
  /** Registered per-chain actions (wallets list + connect/disconnect). */
  actions: WalletActions
  /** Optional icon overrides keyed by wallet name or id. */
  walletIcons: Record<string, string>
  /** Active wagmi config (created by the EVM adapter). Consumers can use it
   * with wagmi/actions (e.g. readContract) without creating a second config. */
  wagmiConfig: Config | null
  connect: (chain: ConnectedChainType, walletId?: string) => Promise<WalletInfo | null>
  disconnect: (chain: ConnectedChainType) => Promise<void>
  disconnectAll: () => void
  /** Force-clear a chain's connecting/error state (used to abort a stuck connect). */
  resetChain: (chain: ConnectedChainType) => void
  getAddress: (chain: ConnectedChainType) => string | null
}

const WalletContext = createContext<WalletContextValue | null>(null)

function emptySlot(): WalletSlot {
  return { wallet: null, connecting: false, error: null }
}

export interface WalletProviderProps {
  mode: 'mainnet' | 'testnet'
  /** Chain config — injected by the app so the package has zero hardcoded chains. */
  chains: ChainConfig[]
  solanaRpc?: string
  appName?: string
  /** Wallet icon overrides keyed by wallet name or id (e.g. "injected" → "/wallets/metamask.png"). */
  walletIcons?: Record<string, string>
  children: ReactNode
}

export function WalletProvider({
  mode,
  chains,
  solanaRpc,
  appName = 'Xansfer',
  walletIcons = {},
  children,
}: WalletProviderProps) {
  const [slots, setSlots] = useState<WalletSlots>(() => ({
    evm: emptySlot(),
    solana: emptySlot(),
    aptos: emptySlot(),
    sui: emptySlot(),
    stellar: emptySlot(),
  }))
  const [wagmiConfig, setWagmiConfig] = useState<Config | null>(null)
  const [actionsVersion, setActionsVersion] = useState(0)
  const actionsRef = useRef<Partial<WalletActions>>({})
  // Set when the user cancels a stuck connect; used to suppress late errors.
  const cancelledRef = useRef<Partial<Record<ConnectedChainType, boolean>>>({})

  const setSlot = useCallback((chain: ConnectedChainType, patch: Partial<WalletSlot>) => {
    setSlots((prev) => ({ ...prev, [chain]: { ...prev[chain], ...patch } }))
  }, [])

  const registerActions = useCallback((chain: ConnectedChainType, actions: ChainActions) => {
    const prev = actionsRef.current[chain]
    // Only bump the version when the wallet list actually changes (ids or
    // availability). Avoids a render loop: adapter effects re-register on every
    // render because wagmi/React Query return fresh references, and bumping
    // unconditionally would re-render WalletProvider → adapters → re-register.
    const prevKey = prev?.wallets?.map((w) => `${w.id}:${w.unavailable}`).join(',') ?? ''
    const nextKey = actions.wallets.map((w) => `${w.id}:${w.unavailable}`).join(',')
    const walletsChanged = prevKey !== nextKey
    actionsRef.current[chain] = actions
    if (walletsChanged) setActionsVersion((v) => v + 1)
  }, [])

  const connect = useCallback(async (chain: ConnectedChainType, walletId?: string) => {
    const a = actionsRef.current[chain]
    if (!a) throw new Error(`No wallet adapter registered for "${chain}"`)
    cancelledRef.current[chain] = false
    setSlot(chain, { connecting: true, error: null })
    try {
      return await a.connect(walletId)
    } catch (e) {
      // If the user dismissed the popup, restore quietly — no scary error.
      // Real failures (no provider, timeout) surface via slot.error.
      const isUserRejected =
        (e as { code?: unknown })?.code === 4001 ||
        (e as { name?: string })?.name === 'UserRejectedRequestError' ||
        String(e).toLowerCase().includes('user rejected') ||
        String(e).toLowerCase().includes('request rejected')
      if (!cancelledRef.current[chain]) {
        setSlot(chain, {
          connecting: false,
          error: isUserRejected ? null : e instanceof Error ? e.message : String(e),
        })
      } else {
        setSlot(chain, { connecting: false })
      }
      throw e
    }
  }, [setSlot])

  const disconnect = useCallback(async (chain: ConnectedChainType) => {
    await actionsRef.current[chain]?.disconnect()
  }, [])

  const disconnectAll = useCallback(() => {
    for (const chain of ALL_CHAIN_TYPES) {
      void actionsRef.current[chain]?.disconnect()
    }
  }, [])

  const resetChain = useCallback((chain: ConnectedChainType) => {
    cancelledRef.current[chain] = true
    setSlot(chain, { wallet: null, connecting: false, error: null })
  }, [setSlot])

  const getAddress = useCallback((chain: ConnectedChainType) => {
    return actionsRef.current[chain]?.getAddress() ?? null
  }, [])

  const state = useMemo<WalletState>(() => {
    const info = {
      evm: slots.evm.wallet,
      solana: slots.solana.wallet,
      aptos: slots.aptos.wallet,
      sui: slots.sui.wallet,
      stellar: slots.stellar.wallet,
    }
    const active = info.evm ?? info.solana ?? info.aptos ?? info.sui ?? info.stellar
    const totalConnected = [info.evm, info.solana, info.aptos, info.sui, info.stellar].filter(Boolean).length
    return {
      ...info,
      connected: totalConnected > 0,
      address: active?.address ?? '',
      chainType: active?.chainType ?? null,
      totalConnected,
    }
  }, [slots])

  const actions = useMemo<WalletActions>(() => {
    const base = {} as WalletActions
    for (const chain of ALL_CHAIN_TYPES) {
      const a = actionsRef.current[chain]
      base[chain] = a ?? {
        chainType: chain,
        wallets: [],
        connect: async () => null,
        disconnect: async () => {},
        getAddress: () => null,
      }
    }
    return base
    // actionsRef is mutated on adapter (re)registration; actionsVersion forces
    // a rebuild so late-registered wallet lists (e.g. dynamically injected OKX)
    // reach the UI.
  }, [slots, actionsVersion])

  const value = useMemo<WalletContextValue>(
    () => ({ state, slots, actions, walletIcons, wagmiConfig, connect, disconnect, disconnectAll, resetChain, getAddress }),
    [state, slots, actions, walletIcons, wagmiConfig, connect, disconnect, disconnectAll, resetChain, getAddress],
  )

  const evmChains = useMemo(() => chains.filter((c) => c.chain_type === 'evm'), [chains])

  return (
    <WalletContext.Provider value={value}>
      <EvmAdapter
        mode={mode}
        chains={evmChains}
        appName={appName}
        setSlot={setSlot}
        setWagmiConfig={setWagmiConfig}
        registerActions={registerActions}
      >
        <SolanaAdapter
          endpoint={solanaRpc}
          setSlot={setSlot}
          registerActions={registerActions}
        >
          <AptosAdapter setSlot={setSlot} registerActions={registerActions}>
            <SuiAdapter mode={mode} setSlot={setSlot} registerActions={registerActions}>
              <StellarAdapter setSlot={setSlot} registerActions={registerActions}>
                {children}
              </StellarAdapter>
            </SuiAdapter>
          </AptosAdapter>
        </SolanaAdapter>
      </EvmAdapter>
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used within <WalletProvider>')
  return ctx
}

export function useWalletState(): WalletState {
  return useWallet().state
}

/** The active wagmi config created by the EVM adapter. */
export function useWagmiConfig(): Config | null {
  return useWallet().wagmiConfig
}
