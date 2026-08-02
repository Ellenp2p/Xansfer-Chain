import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createConfig, http, WagmiProvider, useAccount, useConnect, useDisconnect, type Config } from 'wagmi'
import { injected, coinbaseWallet } from 'wagmi/connectors'
import type { Chain } from 'viem'
import type { EIP1193Provider } from 'viem'
import type { ChainActions, ChainConfig, ConnectedChainType, WalletOption, WalletSlot } from '../core/types'

type SetSlot = (chain: ConnectedChainType, patch: Partial<WalletSlot>) => void
type RegisterActions = (chain: ConnectedChainType, actions: ChainActions) => void

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
 * Detect the OKX provider. OKX injects its EIP-1193 provider under the
 * `window.okxwallet` namespace (per RainbowKit's official connector), with
 * legacy fallbacks on window.ethereum.isOkxWallet / providers.
 */
function okxProvider(window?: Window): EIP1193Provider | undefined {
  const w = window as any
  if (w?.okxwallet) return w.okxwallet as EIP1193Provider
  const eth = w?.ethereum
  if (eth?.isOkxWallet) return eth as EIP1193Provider
  const providers: any[] | undefined = eth?.providers
  return (providers?.find((p) => p.isOkxWallet) ?? undefined) as EIP1193Provider | undefined
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
  const wagmiConfig = useMemo(() => {
    const chainList = buildWagmiChains(chains, mode)
    return createConfig({
      chains: chainList,
      connectors: [
        injected(),
        coinbaseWallet({ appName }),
        // OKX is not in wagmi's targetMap and sometimes does not register
        // EIP-6963, so detect it explicitly by probing window.ethereum.
        injected({
          target: {
            id: 'com.okex.wallet',
            name: 'OKX Wallet',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            provider: okxProvider as any,
          },
        }),
      ],
      transports: Object.fromEntries(chainList.map((c) => [c.id, http()])),
      // Discover injected wallets (MetaMask, Rabby, …) via EIP-6963.
      multiInjectedProviderDiscovery: true,
      // Avoids wagmi's Hydrate calling onMount() during render (which triggers
      // "Cannot update a component while rendering" in React 19). The mount
      // work (reconnect/hydrate) runs in an effect instead.
      ssr: true,
    })
  }, [chains, mode, appName])

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

  // Dedupe by connector id (e.g. OKX may be detected both explicitly and via
  // EIP-6963, both with id 'com.okex.wallet'); prefer the ready one.
  const wallets: WalletOption[] = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; ready: boolean }>()
    for (const c of connectors) {
      const prev = byId.get(c.id)
      if (!prev || (!prev.ready && c.ready)) {
        byId.set(c.id, { id: c.id, name: c.name, ready: !!c.ready })
      }
    }
    return [...byId.values()].map((w) => ({ id: w.id, name: w.name, unavailable: !w.ready }))
  }, [connectors])

  const connect = useCallback(
    async (walletId?: string) => {
      const connector = connectors.find((c) => c.id === walletId) ?? connectors[0]
      if (!connector) throw new Error('No EVM wallet available')
      if (!connector.ready) throw new Error(`No ${connector.name} detected in this browser`)
      // Guard against a wallet popup that never resolves.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for wallet approval')), 90_000),
      )
      const result = await Promise.race([
        connectAsync({ connector }),
        timeout,
      ])
      return { address: result.accounts[0], chainId: result.chainId, chainType: 'evm' as const }
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
