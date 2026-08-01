import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createConfig, http, WagmiProvider, useAccount, useConnect, useDisconnect, type Config } from 'wagmi'
import { injected, coinbaseWallet } from 'wagmi/connectors'
import type { Chain } from 'viem'
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
      connectors: [injected(), coinbaseWallet({ appName })],
      transports: Object.fromEntries(chainList.map((c) => [c.id, http()])),
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

  const wallets: WalletOption[] = useMemo(
    () => connectors.map((c) => ({ id: c.id, name: c.name, unavailable: !c.ready })),
    [connectors],
  )

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
