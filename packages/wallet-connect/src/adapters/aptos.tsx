import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { AptosWalletAdapterProvider, useWallet } from '@aptos-labs/wallet-adapter-react'
import type { ChainActions, ConnectedChainType, WalletInfo, WalletOption, WalletSlot } from '../core/types'

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

  const walletOptions: WalletOption[] = useMemo(
    () => wallets.map((w) => ({ id: w.name, name: w.name, icon: w.icon })),
    [wallets],
  )

  const connectFn = useCallback(
    async (walletId?: string) => {
      const target = walletId
        ? wallets.find((w) => w.name === walletId)
        : wallets.find((w) => w.name === 'Petra') ?? wallets[0]
      if (!target) throw new Error('No Aptos wallet available')
      await connect(target.name)
      return getAddressFromAccount(account)
    },
    [wallets, connect, account],
  )

  const disconnectFn = useCallback(async () => {
    await disconnect()
  }, [disconnect])

  const getAddress = useCallback(
    () => (account ? account.address.toString() : null),
    [account],
  )

  useEffect(() => {
    registerActions('aptos', { chainType: 'aptos', wallets: walletOptions, connect: connectFn, disconnect: disconnectFn, getAddress })
  }, [registerActions, walletOptions, connectFn, disconnectFn, getAddress])

  return null
}

function getAddressFromAccount(account: { address: { toString(): string } } | null): WalletInfo | null {
  if (!account) return null
  return { address: account.address.toString(), chainType: 'aptos' }
}
