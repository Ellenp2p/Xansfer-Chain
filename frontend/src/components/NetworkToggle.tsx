import { useLocation, useNavigate } from 'react-router-dom'
import { Globe } from 'lucide-react'
import { modeFromPath } from '../config/chains'
import { useNetworkMode } from '../stores/networkMode'

/**
 * Switches network by navigating between "/" (mainnet) and "/testnet" paths,
 * keeping the current page.
 */
export default function NetworkToggle() {
  const navigate = useNavigate()
  const location = useLocation()
  const mode = modeFromPath(location.pathname)
  const isTestnet = mode === 'testnet'

  const toggle = () => {
    const base = location.pathname.replace(/^\/testnet/, '') || '/'
    const target = isTestnet ? base : `/testnet${base}`
    // Update the store synchronously so adapters (e.g. Stellar RPC selection)
    // never use a stale mode between navigation and the location effect.
    useNetworkMode.getState().setMode(isTestnet ? 'mainnet' : 'testnet')
    navigate(target, { replace: true })
  }

  return (
    <button
      onClick={toggle}
      title={`Switch to ${isTestnet ? 'Mainnet' : 'Testnet'}`}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition ${
        isTestnet
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
          : 'border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20'
      }`}
    >
      <Globe className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{isTestnet ? 'Testnet' : 'Mainnet'}</span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${isTestnet ? 'bg-amber-400' : 'bg-green-400'}`}
      />
    </button>
  )
}
