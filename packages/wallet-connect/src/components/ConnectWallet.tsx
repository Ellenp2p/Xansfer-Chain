import { useState } from 'react'
import { useWallet } from '../context/WalletProvider'
import { WalletModal } from './WalletModal'

export interface ConnectWalletProps {
  className?: string
  labels?: { connect: string; connected: string }
}

/**
 * One entry point for all chains: a button (showing connected-count badge)
 * that opens the unified wallet modal.
 */
export function ConnectWallet({ className, labels }: ConnectWalletProps) {
  const { state } = useWallet()
  const [open, setOpen] = useState(false)
  const count = state.totalConnected
  const connectedLabel = labels?.connected ?? 'Wallet'

  return (
    <>
      <button
        className={`xw-connect ${count > 0 ? 'xw-connect-active' : ''} ${className ?? ''}`}
        onClick={() => setOpen(true)}
        title={count > 0 ? `${count} wallet${count > 1 ? 's' : ''} connected` : 'Connect wallet'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
        </svg>
        {count > 0 ? (
          <>
            <span className="xw-connect-label">{connectedLabel}</span>
            <span className="xw-connect-badge">{count}</span>
          </>
        ) : (
          <span className="xw-connect-label">{labels?.connect ?? 'Connect'}</span>
        )}
      </button>
      {open && <WalletModal open={open} onClose={() => setOpen(false)} />}
    </>
  )
}
