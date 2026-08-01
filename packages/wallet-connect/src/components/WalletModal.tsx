import { useEffect, useState } from 'react'
import { useWallet } from '../context/WalletProvider'
import type { ConnectedChainType, WalletInfo } from '../core/types'

const CHAIN_LABELS: Record<ConnectedChainType, string> = {
  evm: 'EVM',
  solana: 'Solana',
  aptos: 'Aptos',
  sui: 'Sui',
  stellar: 'Stellar',
}

function truncate(addr: string) {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
}

export interface WalletModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Unified wallet panel. One modal for every supported chain:
 * shows connection state, address, copy + disconnect, and a per-chain connect.
 */
export function WalletModal({ open, onClose }: WalletModalProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="xw-overlay" onClick={onClose}>
      <div className="xw-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="xw-modal-head">
          <h2 className="xw-modal-title">Wallets</h2>
          <button className="xw-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="xw-modal-body">
          <EvmRow />
          <ChainRow chain="solana" />
          <ChainRow chain="aptos" />
          <ChainRow chain="sui" />
          <ChainRow chain="stellar" />
        </div>
      </div>
    </div>
  )
}

function ChainRow({ chain }: { chain: ConnectedChainType }) {
  const { state, connect, disconnect } = useWallet()
  const info: WalletInfo | null = state[chain]
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleConnect = async () => {
    setBusy(true)
    try {
      await connect(chain)
    } catch {
      // error surfaced through slot.error if the adapter sets it
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = () => {
    if (!info?.address) return
    navigator.clipboard.writeText(info.address).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="xw-row">
      <div className="xw-row-main">
        <span className="xw-row-name">{CHAIN_LABELS[chain]}</span>
        {info?.address ? (
          <span className="xw-row-addr">{truncate(info.address)}</span>
        ) : (
          <span className="xw-row-muted">Not connected</span>
        )}
      </div>
      {info?.address ? (
        <div className="xw-row-actions">
          <button className="xw-btn" onClick={handleCopy}>
            {copied ? '✓' : 'Copy'}
          </button>
          <button className="xw-btn xw-btn-danger" onClick={() => void disconnect(chain)}>
            Disconnect
          </button>
        </div>
      ) : (
        <button className="xw-btn xw-btn-accent" onClick={() => void handleConnect()} disabled={busy}>
          {busy ? '...' : 'Connect'}
        </button>
      )}
    </div>
  )
}

function EvmRow() {
  const { state, connect, disconnect, evmConnectors } = useWallet()
  const [picking, setPicking] = useState(false)
  const [copied, setCopied] = useState(false)
  const info = state.evm

  if (!info?.address) {
    return (
      <div className="xw-row xw-row-stack">
        <div className="xw-row">
          <div className="xw-row-main">
            <span className="xw-row-name">EVM</span>
            <span className="xw-row-muted">Not connected</span>
          </div>
          <button className="xw-btn xw-btn-accent" onClick={() => setPicking((v) => !v)}>
            Connect
          </button>
        </div>
        {picking && (
          <div className="xw-connector-list">
            {evmConnectors.length === 0 && <span className="xw-row-muted">No EVM wallets detected</span>}
            {evmConnectors.map((c) => (
              <button
                key={c.id}
                className="xw-btn xw-connector"
                onClick={() => {
                  void connect('evm', c.id)
                  setPicking(false)
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(info.address).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="xw-row">
      <div className="xw-row-main">
        <span className="xw-row-name">EVM</span>
        <span className="xw-row-addr">{truncate(info.address)}</span>
      </div>
      <div className="xw-row-actions">
        <button className="xw-btn" onClick={handleCopy}>
          {copied ? '✓' : 'Copy'}
        </button>
        <button className="xw-btn xw-btn-danger" onClick={() => void disconnect('evm')}>
          Disconnect
        </button>
      </div>
    </div>
  )
}
