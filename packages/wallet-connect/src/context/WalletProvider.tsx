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
  emptyWalletState,
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

export interface ConnectorOption {
  id: string
  name: string
}

export interface WalletContextValue {
  state: WalletState
  /** Registered per-chain actions. */
  actions: WalletActions
  /** Available EVM connectors (e.g. injected, coinbase). Empty for non-EVM. */
  evmConnectors: ConnectorOption[]
  /** Active wagmi config (created by the EVM adapter). Consumers can use it
   * with wagmi/actions (e.g. readContract) without creating a second config. */
  wagmiConfig: Config | null
  connect: (chain: ConnectedChainType, connectorId?: string) => Promise<WalletInfo | null>
  disconnect: (chain: ConnectedChainType) => Promise<void>
  disconnectAll: () => void
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
  children: ReactNode
}

export function WalletProvider({
  mode,
  chains,
  solanaRpc,
  appName = 'Xansfer',
  children,
}: WalletProviderProps) {
  const [slots, setSlots] = useState<WalletSlots>(() => ({
    evm: emptySlot(),
    solana: emptySlot(),
    aptos: emptySlot(),
    sui: emptySlot(),
    stellar: emptySlot(),
  }))
  const [evmConnectors, setEvmConnectors] = useState<ConnectorOption[]>([])
  const [wagmiConfig, setWagmiConfig] = useState<Config | null>(null)
  const actionsRef = useRef<Partial<WalletActions>>({})

  const setSlot = useCallback((chain: ConnectedChainType, patch: Partial<WalletSlot>) => {
    setSlots((prev) => ({ ...prev, [chain]: { ...prev[chain], ...patch } }))
  }, [])

  const registerActions = useCallback((chain: ConnectedChainType, actions: ChainActions) => {
    actionsRef.current[chain] = actions
  }, [])

  const connect = useCallback(async (chain: ConnectedChainType, connectorId?: string) => {
    const a = actionsRef.current[chain]
    if (!a) throw new Error(`No wallet adapter registered for "${chain}"`)
    return a.connect(connectorId)
  }, [])

  const disconnect = useCallback(async (chain: ConnectedChainType) => {
    await actionsRef.current[chain]?.disconnect()
  }, [])

  const disconnectAll = useCallback(() => {
    for (const chain of ALL_CHAIN_TYPES) {
      void actionsRef.current[chain]?.disconnect()
    }
  }, [])

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
        connect: async () => null,
        disconnect: async () => {},
        getAddress: () => null,
      }
    }
    return base
    // actionsRef is mutated on adapter mount; recompute on slot changes so
    // newly-registered actions are picked up.
  }, [slots, emptyWalletState])

  const value = useMemo<WalletContextValue>(
    () => ({ state, actions, evmConnectors, wagmiConfig, connect, disconnect, disconnectAll, getAddress }),
    [state, actions, evmConnectors, wagmiConfig, connect, disconnect, disconnectAll, getAddress],
  )

  const evmChains = useMemo(() => chains.filter((c) => c.chain_type === 'evm'), [chains])

  return (
    <WalletContext.Provider value={value}>
      <EvmAdapter
        mode={mode}
        chains={evmChains}
        appName={appName}
        setSlot={setSlot}
        setConnectors={setEvmConnectors}
        setWagmiConfig={setWagmiConfig}
        registerActions={registerActions}
      >
        <SolanaAdapter
          endpoint={solanaRpc}
          setSlot={setSlot}
          registerActions={registerActions}
        >
          <AptosAdapter setSlot={setSlot} registerActions={registerActions}>
            <SuiAdapter setSlot={setSlot} registerActions={registerActions}>
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
