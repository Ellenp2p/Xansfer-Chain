import { useCallback, useEffect, type ReactNode } from 'react'
import { AptosWalletAdapterProvider, useWallet } from '@aptos-labs/wallet-adapter-react'
import type { ChainActions, ConnectedChainType, WalletInfo, WalletSlot } from '../core/types'

type SetSlot = (chain: ConnectedChainType, patch: Partial<WalletSlot>) => void
type RegisterActions = (chain: ConnectedChainType, actions: ChainActions) => void

interface Props {
  setSlot: SetSlot
  registerActions: RegisterActions
  children: ReactNode
}

export function AptosAdapter({ setSlot, registerActions, children }: Props) {
  return (
    <AptosWalletAdapterProvider autoConnect={true}>
      <AptosSync setSlot={setSlot} registerActions={registerActions} />
      {children}
    </AptosWalletAdapterProvider>
  )
}

function AptosSync({ setSlot, registerActions }: {
  setSlot: SetSlot
  registerActions: RegisterActions
}) {
  const { account, connect, disconnect, wallets } = useWallet()

  useEffect(() => {
    setSlot('aptos', {
      wallet: account ? { address: account.address.toString(), chainType: 'aptos' } : null,
      connecting: false,
      error: null,
    })
  }, [account, setSlot])

  const connectFn = useCallback(async () => {
    const target = wallets.find((w) => w.name === 'Petra') ?? wallets[0]
    if (!target) throw new Error('No Aptos wallet available')
    await connect(target.name)
    return getAddressFromAccount(account)
  }, [wallets, connect, account])

  const disconnectFn = useCallback(async () => {
    await disconnect()
  }, [disconnect])

  const getAddress = useCallback(
    () => (account ? account.address.toString() : null),
    [account],
  )

  useEffect(() => {
    registerActions('aptos', { chainType: 'aptos', connect: connectFn, disconnect: disconnectFn, getAddress })
  }, [registerActions, connectFn, disconnectFn, getAddress])

  return null
}

function getAddressFromAccount(account: { address: { toString(): string } } | null): WalletInfo | null {
  if (!account) return null
  return { address: account.address.toString(), chainType: 'aptos' }
}
