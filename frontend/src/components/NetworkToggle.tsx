import { useNetworkMode } from '../stores/networkMode'
import { Globe } from 'lucide-react'

export default function NetworkToggle() {
  const { mode, toggleMode } = useNetworkMode()
  const isTestnet = mode === 'testnet'

  return (
    <button
      onClick={toggleMode}
      title={`Switch to ${isTestnet ? 'Mainnet' : 'Testnet'}`}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition ${
        isTestnet
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
          : 'border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20'
      }`}
    >
      <Globe className="h-3.5 w-3.5" />
      <span>{isTestnet ? 'Testnet' : 'Mainnet'}</span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isTestnet ? 'bg-amber-400' : 'bg-green-400'
        }`}
      />
    </button>
  )
}
