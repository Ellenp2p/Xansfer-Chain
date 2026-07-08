import { useMemo, type ReactNode } from 'react'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { useNetworkMode } from '../stores/networkMode'
import { getChainByDomain } from '../config/chains'
import '@solana/wallet-adapter-react-ui/styles.css'

const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com'

export default function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const mode = useNetworkMode((s) => s.mode)
  const configChain = getChainByDomain(5, mode)
  const endpoint = import.meta.env.VITE_SOLANA_RPC || configChain?.rpc_url || (mode === 'testnet' ? SOLANA_DEVNET_RPC : 'https://api.mainnet-beta.solana.com')
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], [])

  return (
    <ConnectionProvider key={endpoint} endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
