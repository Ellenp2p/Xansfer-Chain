import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import {
  SuiClientProvider,
  WalletProvider,
  useCurrentAccount,
  useConnectWallet,
  useDisconnectWallet,
  useWallets,
} from '@mysten/dapp-kit'
import type { ChainActions, ConnectedChainType, WalletOption, WalletSlot } from '../core/types'

type SetSlot = (chain: ConnectedChainType, patch: Partial<WalletSlot>) => void
type RegisterActions = (chain: ConnectedChainType, actions: ChainActions) => void

const SUI_RPC_URLS: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
}

interface Props {
  mode?: 'mainnet' | 'testnet'
  rpcUrl?: string
  setSlot: SetSlot
  registerActions: RegisterActions
  children: ReactNode
}

export function SuiAdapter({ mode = 'mainnet', rpcUrl, setSlot, registerActions, children }: Props) {
  const network = mode === 'testnet' ? 'testnet' : 'mainnet'
  void rpcUrl

  return (
    <SuiClientProvider
      networks={{ mainnet: { url: SUI_RPC_URLS.mainnet, network: 'mainnet' }, testnet: { url: SUI_RPC_URLS.testnet, network: 'testnet' } }}
      defaultNetwork={network}
    >
      <WalletProvider>
        <SuiSync setSlot={setSlot} registerActions={registerActions} />
        {children}
      </WalletProvider>
    </SuiClientProvider>
  )
}

function SuiSync({ setSlot, registerActions }: {
  setSlot: SetSlot
  registerActions: RegisterActions
}) {
  const account = useCurrentAccount()
  const { mutate: connect } = useConnectWallet()
  const { mutate: disconnect } = useDisconnectWallet()
  const wallets = useWallets()

  useEffect(() => {
    setSlot('sui', {
      wallet: account ? { address: account.address, chainType: 'sui' } : null,
      connecting: false,
      error: null,
    })
  }, [account, setSlot])

  const walletOptions: WalletOption[] = useMemo(
    () => wallets.map((w) => ({ id: w.name, name: w.name, icon: w.icon })),
    [wallets],
  )

  const connectFn = useCallback(
    async (walletId?: string) => {
      const target = walletId ? wallets.find((w) => w.name === walletId) : wallets[0]
      if (!target) throw new Error('No Sui wallet found')
      connect({ wallet: target })
      return null
    },
    [connect, wallets],
  )

  const disconnectFn = useCallback(async () => {
    disconnect()
  }, [disconnect])

  const getAddress = useCallback(() => (account ? account.address : null), [account])

  useEffect(() => {
    registerActions('sui', { chainType: 'sui', wallets: walletOptions, connect: connectFn, disconnect: disconnectFn, getAddress })
  }, [registerActions, walletOptions, connectFn, disconnectFn, getAddress])

  return null
}
