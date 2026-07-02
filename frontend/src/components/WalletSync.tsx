import { useEffect } from 'react'
import { useAccount } from 'wagmi'
import { useWallet as useSolanaWallet } from '@solana/wallet-adapter-react'
import { useWallet as useAptosWallet } from '@aptos-labs/wallet-adapter-react'
import { useCurrentAccount as useSuiAccount } from '@mysten/dapp-kit'
import { useStellarWallet } from '../providers/StellarWalletProvider'
import { useWalletStore } from '../stores/walletStore'

/**
 * Always-mounted component that syncs wallet SDK state → Zustand store.
 * Runs on every page load so wallets auto-reconnect without opening the panel.
 */
export default function WalletSync() {
  const { setEvmWallet, setSolanaWallet, setAptosWallet, setSuiWallet, setStellarWallet } = useWalletStore()

  // EVM (wagmi)
  const { address: evmAddr, isConnected: evmConnected } = useAccount()
  useEffect(() => {
    if (evmConnected && evmAddr) {
      setEvmWallet({ address: evmAddr, chainType: 'evm' })
    } else {
      setEvmWallet(null)
    }
  }, [evmConnected, evmAddr, setEvmWallet])

  // Solana
  const solanaWallet = useSolanaWallet()
  useEffect(() => {
    if (solanaWallet.connected && solanaWallet.publicKey) {
      setSolanaWallet({ address: solanaWallet.publicKey.toBase58(), chainType: 'solana' })
    } else {
      setSolanaWallet(null)
    }
  }, [solanaWallet.connected, solanaWallet.publicKey, setSolanaWallet])

  // Aptos
  const { account: aptosAccount } = useAptosWallet()
  useEffect(() => {
    if (aptosAccount) {
      setAptosWallet({ address: aptosAccount.address.toString(), chainType: 'aptos', domain: 14 })
    } else {
      setAptosWallet(null)
    }
  }, [aptosAccount, setAptosWallet])

  // SUI
  const suiAccount = useSuiAccount()
  useEffect(() => {
    if (suiAccount) {
      setSuiWallet({ address: suiAccount.address, chainType: 'sui', domain: 8 })
    } else {
      setSuiWallet(null)
    }
  }, [suiAccount, setSuiWallet])

  // Stellar
  const stellarWallet = useStellarWallet()
  useEffect(() => {
    if (stellarWallet.connected && stellarWallet.address) {
      setStellarWallet({ address: stellarWallet.address, chainType: 'stellar', domain: 27 })
    } else {
      setStellarWallet(null)
    }
  }, [stellarWallet.connected, stellarWallet.address, setStellarWallet])

  return null
}
