import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { useNetworkMode } from '../stores/networkMode'
import '@solana/wallet-adapter-react-ui/styles.css'

const SOLANA_MAINNET_RPC = import.meta.env.VITE_SOLANA_RPC || 'https://api.mainnet-beta.solana.com'
const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com'

export default function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const mode = useNetworkMode((s) => s.mode)
  const endpoint = mode === 'testnet' ? SOLANA_DEVNET_RPC : SOLANA_MAINNET_RPC
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], [])

  return (
    <ConnectionProvider key={endpoint} endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
