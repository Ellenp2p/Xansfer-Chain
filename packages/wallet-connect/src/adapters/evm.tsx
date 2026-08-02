import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createConfig, http, WagmiProvider, useAccount, useConnect, useDisconnect, type Config } from 'wagmi'
import { injected, coinbaseWallet } from 'wagmi/connectors'
import { reconnect } from 'wagmi/actions'
import type { Chain } from 'viem'
import type { EIP1193Provider } from 'viem'
import type { ChainActions, ChainConfig, ConnectedChainType, WalletOption, WalletSlot } from '../core/types'

type SetSlot = (chain: ConnectedChainType, patch: Partial<WalletSlot>) => void
type RegisterActions = (chain: ConnectedChainType, actions: ChainActions) => void

const OKX_RDNS = 'com.okex.wallet'
const OKX_CONNECTOR_ID = 'com.okex.wallet'

function buildWagmiChains(chains: ChainConfig[], mode: 'mainnet' | 'testnet'): [Chain, ...Chain[]] {
  const list = chains
    .filter((c) => c.chain_id != null)
    .map((c) => ({
      id: c.chain_id!,
      name: c.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [c.rpc_url] } },
      blockExplorers: { default: { name: c.name, url: c.explorer_url } },
      testnet: mode === 'testnet',
    })) as Chain[]

  if (list.length === 0) {
    throw new Error('[wallet-connect] EvmAdapter requires at least one EVM chain in `chains`')
  }
  return [list[0], ...list.slice(1)]
}

/**
 * Detect the OKX EIP-1193 provider.
 *
 * OKX injects its provider via several possible surfaces:
 *   1. the `window.okxwallet` namespace (RainbowKit's official detection)
 *   2. `window.ethereum` with `isOkxWallet: true` (when OKX owns window.ethereum)
 *   3. `window.ethereum.providers[]` with `isOkxWallet: true` (multi-wallet)
 *   4. EIP-6963 `eip6963:announceProvider` with rdns `com.okex.wallet`
 *
 * We actively announce-request + listen, and poll the window probes because
 * extensions can inject asynchronously after page load.
 */
function useOkxProvider(): EIP1193Provider | undefined {
  const [provider, setProvider] = useState<EIP1193Provider>()

  useEffect(() => {
    let cancelled = false
    const w = window as any

    const probe = (): EIP1193Provider | undefined => {
      if (w?.okxwallet) return w.okxwallet as EIP1193Provider
      const eth = w?.ethereum
      if (eth?.isOkxWallet) return eth as EIP1193Provider
      const providers: any[] | undefined = eth?.providers
      return providers?.find((p) => p.isOkxWallet) as EIP1193Provider | undefined
    }

    const apply = (p: EIP1193Provider | undefined) => {
      if (p && !cancelled) setProvider(p)
    }

    apply(probe())

    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (!d?.provider) return
      const rdns = String(d?.info?.rdns ?? '').toLowerCase()
      const name = String(d?.info?.name ?? '').toLowerCase()
      if (rdns === OKX_RDNS || name.includes('okx') || name.includes('okex')) {
        apply(d.provider as EIP1193Provider)
      }
    }
    window.addEventListener('eip6963:announceProvider', handler)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    // OKX may inject late — poll for a while
    let attempts = 0
    const timer = setInterval(() => {
      const p = probe()
      if (p) {
        apply(p)
        clearInterval(timer)
      } else if (++attempts > 24) {
        clearInterval(timer) // ~12s max
      }
    }, 500)

    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('eip6963:announceProvider', handler)
    }
  }, [])

  return provider
}

interface Props {
  mode: 'mainnet' | 'testnet'
  chains: ChainConfig[]
  appName: string
  setSlot: SetSlot
  setWagmiConfig: (c: Config | null) => void
  registerActions: RegisterActions
  children: ReactNode
}

export function EvmAdapter({ mode, chains, appName, setSlot, setWagmiConfig, registerActions, children }: Props) {
  const okxProvider = useOkxProvider()

  const wagmiConfig = useMemo(() => {
    const chainList = buildWagmiChains(chains, mode)
    return createConfig({
      chains: chainList,
      connectors: [injected(), coinbaseWallet({ appName })],
      transports: Object.fromEntries(chainList.map((c) => [c.id, http()])),
      // ssr:true is a wagmi flag (NOT real server-side rendering): it runs the
      // hydrate/reconnect work inside an effect instead of during render, which
      // (a) removes the React "Cannot update during render" warning and
      // (b) lets the default storage persist the connection so the wallet stays
      // connected after a page refresh.
      // OKX is detected by our own probe + dynamic injection, so it keeps
      // working without wagmi's EIP-6963 auto-discovery.
      ssr: true,
    })
  }, [chains, mode, appName])

  // Inject the OKX connector as soon as its provider is detected. Done
  // dynamically (not in the initial list) so it never blocks the EIP-6963
  // entry via connector-id de-dup, and so a late-injected OKX still shows up.
  useEffect(() => {
    if (!okxProvider || !wagmiConfig) return
    const exists = wagmiConfig.connectors.some((c) => c.id === OKX_CONNECTOR_ID)
    if (exists) return
    const okxConnectorFn = injected({
      target: {
        id: OKX_CONNECTOR_ID,
        name: 'OKX Wallet',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: okxProvider as any,
      },
    })
    wagmiConfig._internal.connectors.setState((prev) => {
      if (prev.some((c) => c.id === OKX_CONNECTOR_ID)) return prev
      const connector = wagmiConfig._internal.connectors.setup(okxConnectorFn)
      return [...prev, connector]
    })
    // The OKX connector is injected after wagmi's initial reconnect (onMount),
    // so it never auto-reconnects after a refresh. If OKX was the last
    // connected wallet, reconnect explicitly now that the connector exists.
    ;(async () => {
      try {
        const recent = await wagmiConfig.storage?.getItem('recentConnectorId')
        if (recent === OKX_CONNECTOR_ID) await reconnect(wagmiConfig)
      } catch {
        // ignore — OKX just won't auto-reconnect
      }
    })()
  }, [okxProvider, wagmiConfig])

  useEffect(() => {
    setWagmiConfig(wagmiConfig)
    return () => setWagmiConfig(null)
  }, [wagmiConfig, setWagmiConfig])

  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <EvmSync setSlot={setSlot} registerActions={registerActions} />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}

function EvmSync({ setSlot, registerActions }: {
  setSlot: SetSlot
  registerActions: RegisterActions
}) {
  const { address, isConnected, chainId, status } = useAccount()
  const { connectors, connectAsync } = useConnect()
  const { disconnectAsync } = useDisconnect()

  useEffect(() => {
    setSlot('evm', {
      wallet: isConnected && address ? { address, chainId, chainType: 'evm' } : null,
      connecting: status === 'connecting' || status === 'reconnecting',
      error: null,
    })
  }, [address, isConnected, chainId, status, setSlot])

  // wagmi v3 connectors have no `ready` property — detect availability by
  // probing each connector's provider.
  const [availMap, setAvailMap] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const map: Record<string, boolean> = {}
      await Promise.all(
        connectors.map(async (c) => {
          try {
            const p = await c.getProvider()
            map[c.id] = !!p
          } catch {
            map[c.id] = false
          }
        }),
      )
      if (!cancelled) setAvailMap(map)
    })()
    return () => {
      cancelled = true
    }
  }, [connectors])

  // Dedupe by connector id (e.g. OKX may be injected both by us and via
  // EIP-6963); prefer the available one.
  const wallets: WalletOption[] = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; unavailable: boolean }>()
    for (const c of connectors) {
      const prev = byId.get(c.id)
      const unavailable = availMap[c.id] === false
      if (!prev || (prev.unavailable && !unavailable)) {
        byId.set(c.id, { id: c.id, name: c.name, unavailable })
      }
    }
    return [...byId.values()]
  }, [connectors, availMap])

  const connect = useCallback(
    async (walletId?: string) => {
      const connector = connectors.find((c) => c.id === walletId) ?? connectors[0]
      if (!connector) throw new Error('No EVM wallet available')
      // wagmi v3 has no connector.ready — probe the provider directly.
      const provider = await connector.getProvider()
      if (!provider) throw new Error(`No ${connector.name} detected in this browser`)

      // Some wallets (e.g. OKX) hang instead of rejecting when the user
      // dismisses the popup (closes the window without clicking reject) —
      // `eth_requestAccounts` never settles. Detect dismissal via provider
      // events (disconnect / accountsChanged → empty) and abort immediately.
      let rejectCancel: ((e: Error) => void) | undefined
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancel = reject
      })
      const onDisconnect = () => rejectCancel?.(new Error('Connection cancelled'))
      const onAccountsChanged = (accounts: unknown[]) => {
        if (Array.isArray(accounts) && accounts.length === 0) rejectCancel?.(new Error('Connection cancelled'))
      }
      const eth = provider as unknown as EIP1193Provider
      if (typeof eth.on === 'function') {
        eth.on('disconnect', onDisconnect as never)
        eth.on('accountsChanged', onAccountsChanged as never)
      }
      const cleanup = () => {
        if (typeof eth.removeListener === 'function') {
          eth.removeListener('disconnect', onDisconnect as never)
          eth.removeListener('accountsChanged', onAccountsChanged as never)
        }
      }

      // Guard against a popup that never resolves (fallback when no
      // disconnect/accountsChanged event is emitted).
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for wallet approval')), 12_000),
      )
      try {
        const result = await Promise.race([connectAsync({ connector }), timeout, cancelled])
        return { address: result.accounts[0], chainId: result.chainId, chainType: 'evm' as const }
      } finally {
        cleanup()
      }
    },
    [connectors, connectAsync],
  )

  const disconnect = useCallback(async () => {
    await disconnectAsync()
  }, [disconnectAsync])

  const getAddress = useCallback(
    () => (isConnected && address ? address : null),
    [address, isConnected],
  )

  useEffect(() => {
    registerActions('evm', { chainType: 'evm', wallets, connect, disconnect, getAddress })
  }, [registerActions, wallets, connect, disconnect, getAddress])

  return null
}
