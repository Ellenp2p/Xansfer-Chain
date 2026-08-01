import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { WalletModalProvider, useWalletModal } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import type { ChainActions, ConnectedChainType, WalletSlot } from '../core/types'

type SetSlot = (chain: ConnectedChainType, patch: Partial<WalletSlot>) => void
type RegisterActions = (chain: ConnectedChainType, actions: ChainActions) => void

interface Props {
  endpoint?: string
  setSlot: SetSlot
  registerActions: RegisterActions
  children: ReactNode
}

export function SolanaAdapter({ endpoint, setSlot, registerActions, children }: Props) {
  const rpc = endpoint || 'https://api.mainnet-beta.solana.com'
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], [])

  return (
    <ConnectionProvider endpoint={rpc}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SolanaSync setSlot={setSlot} registerActions={registerActions} />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

function SolanaSync({ setSlot, registerActions }: {
  setSlot: SetSlot
  registerActions: RegisterActions
}) {
  const solanaWallet = useWallet()
  const { setVisible } = useWalletModal()

  useEffect(() => {
    setSlot('solana', {
      wallet:
        solanaWallet.connected && solanaWallet.publicKey
          ? { address: solanaWallet.publicKey.toBase58(), chainType: 'solana' }
          : null,
      connecting: solanaWallet.connecting,
      error: null,
    })
  }, [solanaWallet.connected, solanaWallet.publicKey, solanaWallet.connecting, setSlot])

  const connect = useCallback(async () => {
    // Solana presents its own wallet-selection modal.
    setVisible(true)
    return null
  }, [setVisible])

  const disconnect = useCallback(async () => {
    await solanaWallet.disconnect()
  }, [solanaWallet])

  const getAddress = useCallback(
    () => (solanaWallet.connected && solanaWallet.publicKey ? solanaWallet.publicKey.toBase58() : null),
    [solanaWallet],
  )

  useEffect(() => {
    registerActions('solana', { chainType: 'solana', connect, disconnect, getAddress })
  }, [registerActions, connect, disconnect, getAddress])

  return null
}
