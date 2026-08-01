import { useCallback, useEffect, type ReactNode } from 'react'
import {
  SuiClientProvider,
  WalletProvider,
  useCurrentAccount,
  useConnectWallet,
  useDisconnectWallet,
  useWallets,
} from '@mysten/dapp-kit'
import type { ChainActions, ConnectedChainType, WalletSlot } from '../core/types'

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

  const connectFn = useCallback(async () => {
    if (wallets[0]) {
      connect({ wallet: wallets[0] })
    } else {
      // No registered wallet in this browser — nothing to show, keep modal-based flows out.
      throw new Error('No Sui wallet found')
    }
    return null
  }, [connect, wallets])

  const disconnectFn = useCallback(async () => {
    disconnect()
  }, [disconnect])

  const getAddress = useCallback(() => (account ? account.address : null), [account])

  useEffect(() => {
    registerActions('sui', { chainType: 'sui', connect: connectFn, disconnect: disconnectFn, getAddress })
  }, [registerActions, connectFn, disconnectFn, getAddress])

  return null
}
