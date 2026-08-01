import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWallet } from '../context/WalletProvider'
import type { ConnectedChainType, WalletInfo } from '../core/types'

const CHAIN_TABS: { key: ConnectedChainType; label: string }[] = [
  { key: 'evm', label: 'EVM' },
  { key: 'solana', label: 'Solana' },
  { key: 'aptos', label: 'Aptos' },
  { key: 'sui', label: 'Sui' },
  { key: 'stellar', label: 'Stellar' },
]

export interface WalletModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Unified wallet modal: pick a chain tab, then a wallet for that chain.
 * Rendered via a portal so it is centered on the viewport regardless of any
 * ancestor with backdrop-filter/transform. Collapses to a bottom sheet on
 * narrow screens.
 */
export function WalletModal({ open, onClose }: WalletModalProps) {
  const [tab, setTab] = useState<ConnectedChainType>('evm')

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="xw-overlay" onClick={onClose}>
      <div className="xw-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="xw-modal-head">
          <h2 className="xw-modal-title">Connect Wallet</h2>
          <button className="xw-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="xw-tabs" role="tablist">
          {CHAIN_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`xw-tab ${tab === t.key ? 'xw-tab-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="xw-modal-body">
          <ChainTab key={tab} chain={tab} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ChainTab({ chain }: { chain: ConnectedChainType }) {
  const { state, slots, actions, walletIcons, connect, disconnect, resetChain } = useWallet()
  const info: WalletInfo | null = state[chain]
  const slot = slots[chain]
  const wallets = actions[chain].wallets
  const [busyId, setBusyId] = useState<string | null>(null)
  const busy = busyId !== null || slot.connecting

  const handleConnect = async (walletId: string) => {
    setBusyId(walletId)
    try {
      await connect(chain, walletId)
    } catch {
      // error is surfaced through slot.error
    } finally {
      setBusyId(null)
    }
  }

  const handleCancel = async () => {
    setBusyId(null)
    resetChain(chain)
    try {
      await disconnect(chain)
    } catch {
      // ignore — state is already cleared
    }
  }

  if (info?.address && !busy) {
    return <ConnectedView chain={chain} info={info} />
  }

  // Stuck waiting on a wallet popup → give the user a hard cancel.
  if (busy) {
    return (
      <div className="xw-waiting">
        <p className="xw-row-muted">
          Waiting for the wallet to approve… If nothing opened, check your wallet extension.
        </p>
        <button className="xw-btn xw-btn-danger xw-cancel" onClick={() => void handleCancel()}>
          Cancel &amp; disconnect
        </button>
      </div>
    )
  }

  return (
    <div className="xw-wallet-grid">
      {wallets.length === 0 && (
        <p className="xw-row-muted">No wallets detected for this chain.</p>
      )}
      {wallets.map((w) => {
        const icon = w.icon || walletIcons[w.name] || walletIcons[w.id]
        return (
          <button
            key={w.id}
            className="xw-wallet-card"
            disabled={w.unavailable}
            onClick={() => void handleConnect(w.id)}
          >
            {icon ? (
              <img className="xw-wallet-icon" src={icon} alt="" />
            ) : (
              <span className="xw-wallet-monogram">{w.name.charAt(0).toUpperCase()}</span>
            )}
            <span className="xw-wallet-name">
              {w.unavailable ? 'Not detected' : w.name}
            </span>
          </button>
        )
      })}
      {slot.error && <p className="xw-row-error">{slot.error}</p>}
    </div>
  )
}

function ConnectedView({ chain, info }: { chain: ConnectedChainType; info: WalletInfo }) {
  const { disconnect } = useWallet()
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(info.address).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="xw-connected">
      <div className="xw-connected-addr">
        <span className="xw-row-name">{CHAIN_TABS.find((t) => t.key === chain)?.label}</span>
        <span className="xw-row-addr">{info.address}</span>
      </div>
      <div className="xw-row-actions">
        <button className="xw-btn" onClick={handleCopy}>
          {copied ? '✓' : 'Copy'}
        </button>
        <button className="xw-btn xw-btn-danger" onClick={() => void disconnect(chain)}>
          Disconnect
        </button>
      </div>
    </div>
  )
}
