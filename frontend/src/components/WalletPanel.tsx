import { useEffect } from 'react'
import { useAccount, useDisconnect } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useWallet as useSolanaWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useWallet as useAptosWallet } from '@aptos-labs/wallet-adapter-react'
import { useCurrentAccount as useSuiAccount, useDisconnectWallet as useSuiDisconnect } from '@mysten/dapp-kit'
import { useStellarWallet } from '../providers/StellarWalletProvider'
import { useWalletStore } from '../stores/walletStore'
import { Zap, Wallet, Star, X, Copy, Check, Hexagon, Diamond, LogOut } from 'lucide-react'
import { useState } from 'react'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function WalletPanel({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-t-2xl sm:rounded-2xl border border-gray-700 bg-gray-900 p-5 sm:p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white">Wallets</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white transition">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <EvmRow />
          <SolanaRow />
          <AptosRow />
          <SuiRow />
          <StellarRow />
        </div>
      </div>
    </div>
  )
}

function WalletRow({ icon: Icon, iconColor, iconBg, connectBg, name, address, onDisconnect, onConnect, connectLabel }: {
  icon: typeof Zap
  iconColor: string
  iconBg: string
  connectBg?: string
  name: string
  address: string | null
  onDisconnect: () => void
  onConnect?: () => void
  connectLabel?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/50 p-3.5">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconBg}`}>
        <Icon className={`h-5 w-5 ${iconColor}`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">{name}</p>
        {address ? (
          <p className="text-xs text-gray-400 font-mono truncate">{truncate(address)}</p>
        ) : (
          <p className="text-xs text-gray-500">Not connected</p>
        )}
      </div>
      {address ? (
        <div className="flex items-center gap-1">
          <button
            onClick={() => { copyToClipboard(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-700 hover:text-white transition"
            title="Copy address"
          >
            {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            onClick={onDisconnect}
            className="rounded-lg p-2 text-gray-400 hover:bg-red-500/20 hover:text-red-400 transition"
            title="Disconnect"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      ) : onConnect ? (
        <button
          onClick={onConnect}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-80 ${connectBg ?? 'bg-gray-600'}`}
        >
          {connectLabel ?? 'Connect'}
        </button>
      ) : null}
    </div>
  )
}

// ── EVM ─────────────────────────────────────────────────────────────────────

function EvmRow() {
  const { evm, setEvmWallet } = useWalletStore()
  const { address, isConnected } = useAccount()
  const { disconnect: wagmiDisconnect } = useDisconnect()
  const { openConnectModal } = useConnectModal()

  // Sync wagmi state → store (bidirectional)
  useEffect(() => {
    if (isConnected && address) {
      setEvmWallet({ address, chainType: 'evm' })
    } else {
      setEvmWallet(null)
    }
  }, [isConnected, address, setEvmWallet])

  function handleDisconnect() {
    wagmiDisconnect()
    setEvmWallet(null)
  }

  return <WalletRow icon={Zap} iconColor="text-blue-400" iconBg="bg-blue-500/10" connectBg="bg-blue-600" name="EVM" address={evm?.address ?? null} onDisconnect={handleDisconnect} onConnect={openConnectModal} />
}

// ── Solana ──────────────────────────────────────────────────────────────────

function SolanaRow() {
  const { solana, setSolanaWallet } = useWalletStore()
  const solanaWallet = useSolanaWallet()
  const { setVisible: setSolanaModalVisible } = useWalletModal()

  useEffect(() => {
    if (solanaWallet.connected && solanaWallet.publicKey) {
      setSolanaWallet({ address: solanaWallet.publicKey.toBase58(), chainType: 'solana' })
    } else {
      setSolanaWallet(null)
    }
  }, [solanaWallet.connected, solanaWallet.publicKey, setSolanaWallet])

  function handleDisconnect() {
    solanaWallet.disconnect()
    setSolanaWallet(null)
  }

  return <WalletRow icon={Wallet} iconColor="text-purple-400" iconBg="bg-purple-500/10" connectBg="bg-purple-600" name="Solana" address={solana?.address ?? null} onDisconnect={handleDisconnect} onConnect={() => setSolanaModalVisible(true)} />
}

// ── Aptos ───────────────────────────────────────────────────────────────────

function AptosRow() {
  const { aptos, setAptosWallet } = useWalletStore()
  const { account, connect, disconnect: aptosDisconnect, wallets } = useAptosWallet()

  useEffect(() => {
    if (account) {
      setAptosWallet({ address: account.address.toString(), chainType: 'aptos', domain: 14 })
    } else {
      setAptosWallet(null)
    }
  }, [account, setAptosWallet])

  function handleDisconnect() {
    aptosDisconnect()
    setAptosWallet(null)
  }

  function handleConnect() {
    const petra = wallets.find((w) => w.name === 'Petra')
    if (petra) connect(petra.name)
    else if (wallets.length > 0) connect(wallets[0].name)
  }

  return <WalletRow icon={Hexagon} iconColor="text-orange-400" iconBg="bg-orange-500/10" connectBg="bg-orange-600" name="Aptos" address={aptos?.address ?? null} onDisconnect={handleDisconnect} onConnect={handleConnect} />
}

// ── SUI ─────────────────────────────────────────────────────────────────────

function SuiRow() {
  const { sui, setSuiWallet } = useWalletStore()
  const suiAccount = useSuiAccount()
  const { mutate: suiDisconnect } = useSuiDisconnect()

  useEffect(() => {
    if (suiAccount) {
      setSuiWallet({ address: suiAccount.address, chainType: 'sui', domain: 8 })
    } else {
      setSuiWallet(null)
    }
  }, [suiAccount, setSuiWallet])

  function handleDisconnect() {
    suiDisconnect()
    setSuiWallet(null)
  }

  function handleConnect() {
    const btn = document.querySelector('[data-testid="connect-button"]') as HTMLElement
    if (btn) btn.click()
  }

  return <WalletRow icon={Diamond} iconColor="text-cyan-400" iconBg="bg-cyan-500/10" connectBg="bg-cyan-600" name="SUI" address={sui?.address ?? null} onDisconnect={handleDisconnect} onConnect={handleConnect} />
}

// ── Stellar ─────────────────────────────────────────────────────────────────

function StellarRow() {
  const { stellar, setStellarWallet } = useWalletStore()
  const stellarWallet = useStellarWallet()

  useEffect(() => {
    if (stellarWallet.connected && stellarWallet.address) {
      setStellarWallet({ address: stellarWallet.address, chainType: 'stellar', domain: 27 })
    } else {
      setStellarWallet(null)
    }
  }, [stellarWallet.connected, stellarWallet.address, setStellarWallet])

  function handleDisconnect() {
    stellarWallet.disconnect()
    setStellarWallet(null)
  }

  return <WalletRow icon={Star} iconColor="text-sky-400" iconBg="bg-sky-500/10" connectBg="bg-sky-600" name="Stellar" address={stellar?.address ?? null} onDisconnect={handleDisconnect} onConnect={stellarWallet.connect} />
}
