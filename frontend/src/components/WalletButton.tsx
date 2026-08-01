import { useWalletStore } from '../stores/walletStore'
import { Wallet } from 'lucide-react'

interface Props {
  onClick: () => void
}

export default function WalletButton({ onClick }: Props) {
  const { evm, solana, stellar, aptos, sui } = useWalletStore()
  const count = [evm, solana, stellar, aptos, sui].filter(Boolean).length

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
        count > 0
          ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
          : 'border border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
      }`}
      title={count > 0 ? `${count} wallet${count > 1 ? 's' : ''} connected` : 'Connect wallet'}
    >
      <Wallet className="h-3.5 w-3.5" />
      {count > 0 && (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-[10px] font-bold text-white">
          {count}
        </span>
      )}
      <span className="hidden sm:inline">
        {count > 0 ? 'Wallet' : 'Connect'}
      </span>
    </button>
  )
}
