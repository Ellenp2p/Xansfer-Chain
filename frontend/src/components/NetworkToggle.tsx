import { useLocation, useNavigate } from 'react-router-dom'
import { modeFromPath, type Mode } from '../config/chains'
import { useNetworkMode } from '../stores/networkMode'
import { useTransferStore } from '../stores/transferStore'

interface NetworkToggleProps {
  /** Optional size variant. `compact` keeps the pill narrow on very small screens. */
  size?: 'default' | 'compact'
}

/**
 * Segmented network switcher.
 *
 * On mobile it shows abbreviated labels (Main / Test) inside a clear two-state
 * pill, so the active network is obvious and switching is a single tap. On
 * desktop it expands to full labels (Mainnet / Testnet).
 */
export default function NetworkToggle({ size = 'default' }: NetworkToggleProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const mode = modeFromPath(location.pathname)
  const isTestnet = mode === 'testnet'
  // A mid-flight burn/claim must not hop modes — the adapters captured the old
  // mode's contracts and RPCs for this transfer.
  const inFlight = useTransferStore((s) => s.inFlight)

  const switchTo = (targetMode: Mode) => {
    if (targetMode === mode || inFlight) return
    const base = location.pathname.replace(/^\/mainnet/, '') || '/'
    const target = targetMode === 'mainnet' ? `/mainnet${base}` : base
    // Update the store synchronously so adapters (e.g. Stellar RPC selection)
    // never use a stale mode between navigation and the location effect.
    useNetworkMode.getState().setMode(targetMode)
    navigate(target, { replace: true })
  }

  const pillBase =
    'inline-flex items-center rounded-full border bg-gray-900 p-1 transition'
  const segmentBase =
    'rounded-full px-2.5 py-1 text-xs font-semibold transition sm:px-3'

  return (
    <div
      className={`${pillBase} ${
        isTestnet ? 'border-amber-500/40' : 'border-green-500/40'
      } ${size === 'compact' ? 'scale-95 origin-right' : ''}`}
      role="group"
      aria-label="Network mode"
    >
      <button
        onClick={() => switchTo('mainnet')}
        aria-pressed={!isTestnet}
        disabled={inFlight}
        title={inFlight ? 'Finish the in-flight transfer before switching networks' : undefined}
        className={`${segmentBase} disabled:cursor-not-allowed disabled:opacity-50 ${
          !isTestnet
            ? 'bg-green-500 text-white shadow'
            : 'text-gray-400 hover:text-gray-200'
        }`}
      >
        <span className="sm:hidden">Main</span>
        <span className="hidden sm:inline">Mainnet</span>
      </button>
      <button
        onClick={() => switchTo('testnet')}
        aria-pressed={isTestnet}
        disabled={inFlight}
        title={inFlight ? 'Finish the in-flight transfer before switching networks' : undefined}
        className={`${segmentBase} disabled:cursor-not-allowed disabled:opacity-50 ${
          isTestnet
            ? 'bg-amber-500 text-white shadow'
            : 'text-gray-400 hover:text-gray-200'
        }`}
      >
        <span className="sm:hidden">Test</span>
        <span className="hidden sm:inline">Testnet</span>
      </button>
    </div>
  )
}
