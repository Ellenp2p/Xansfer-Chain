import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { useStandardWalletAdapters } from '@solana/wallet-standard-wallet-adapter-react'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import type { WalletAdapter } from '@solana/wallet-adapter-base'
import { WalletReadyState } from '@solana/wallet-adapter-base'
import type { ChainActions, ConnectedChainType, WalletOption, WalletSlot } from '../core/types'

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
          <SolanaSync wallets={wallets} setSlot={setSlot} registerActions={registerActions} />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

function SolanaSync({ wallets, setSlot, registerActions }: {
  wallets: WalletAdapter[]
  setSlot: SetSlot
  registerActions: RegisterActions
}) {
  const solanaWallet = useWallet()
  // Merge explicit adapters with all Wallet Standard wallets (OKX, etc.) that
  // are installed in this browser. The WalletProvider inside uses the same
  // hook, so select(name) stays in sync.
  const allAdapters = useStandardWalletAdapters(wallets)

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

  const walletOptions: WalletOption[] = useMemo(
    () =>
      allAdapters.map((w) => ({
        id: w.name,
        name: w.name,
        icon: w.icon,
        unavailable:
          w.readyState === WalletReadyState.NotDetected ||
          w.readyState === WalletReadyState.Unsupported,
      })),
    [allAdapters],
  )

  const connect = useCallback(
    async (walletId?: string) => {
      if (walletId) {
        solanaWallet.select(walletId as never)
        // let the wallet adapter apply the selection before connecting
        await new Promise((r) => setTimeout(r, 0))
      }
      if (!solanaWallet.connected) {
        await solanaWallet.connect()
      }
      return solanaWallet.connected && solanaWallet.publicKey
        ? { address: solanaWallet.publicKey.toBase58(), chainType: 'solana' as const }
        : null
    },
    [solanaWallet],
  )

  const disconnect = useCallback(async () => {
    await solanaWallet.disconnect()
  }, [solanaWallet])

  const getAddress = useCallback(
    () => (solanaWallet.connected && solanaWallet.publicKey ? solanaWallet.publicKey.toBase58() : null),
    [solanaWallet],
  )

  useEffect(() => {
    registerActions('solana', { chainType: 'solana', wallets: walletOptions, connect, disconnect, getAddress })
  }, [registerActions, walletOptions, connect, disconnect, getAddress])

  return null
}
