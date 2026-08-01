import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWalletState } from '@xansfer/wallet-connect'
import { useTransferStore } from '../stores/transferStore'
import { useNetworkMode } from '../stores/networkMode'
import { useCctpTransfer } from '../hooks/useCctpTransfer'
import { getTransferTypes, getChainTypeForDomain, getSupportedVersions } from '../config/chains'
import ChainSelector from './ChainSelector'
import type { TransferType } from '../types'
import { ArrowDownUp, Zap, Send, Radio, AlertCircle, Wallet, Layers, Loader2 } from 'lucide-react'

const TRANSFER_META: Record<TransferType, { label: string; icon: typeof Zap; desc: string }> = {
  standard: { label: 'Standard', icon: Send, desc: 'Standard CCTP transfer' },
  fast: { label: 'Fast Transfer', icon: Zap, desc: '< 20s, requires fast-transfer capable chains' },
  forward: { label: 'Forward', icon: ArrowDownUp, desc: 'Auto-forward attestation to destination' },
  relay: { label: 'Relay', icon: Radio, desc: 'Server-submits destination tx for you' },
}

export default function TransferForm() {
  const navigate = useNavigate()
  const wallet = useWalletState()
  const store = useTransferStore()
  const mode = useNetworkMode((s) => s.mode)
  const { step, error: transferError, sourceTxHash, startTransfer, reset } = useCctpTransfer()
  const [destAddress, setDestAddress] = useState('')
  const [useCustomDestAddress, setUseCustomDestAddress] = useState(false)
  const [cctpVersion, setCctpVersion] = useState(2)

  const submitting = step !== 'idle' && step !== 'error' && step !== 'complete' && step !== 'submitted'

  // Reset domain selections when network mode changes
  const prevMode = useNetworkMode((s) => s.mode)
  useEffect(() => {
    store.setSourceDomain(null as unknown as number)
    store.setDestDomain(null as unknown as number)
    store.setTransferType('standard')
    setCctpVersion(2)
    setDestAddress('')
    setUseCustomDestAddress(false)
  }, [prevMode])

  // Navigate to status page when ready
  useEffect(() => {
    if ((step === 'complete' || step === 'submitted') && sourceTxHash) {
      navigate(`/tx/${sourceTxHash}`)
    }
  }, [step, sourceTxHash, navigate])

  // Compute available transfer types locally (no backend needed)
  const availableTypes = useMemo(() => {
    if (store.sourceDomain == null || store.destDomain == null) return []
    return getTransferTypes(store.sourceDomain, store.destDomain, mode)
  }, [store.sourceDomain, store.destDomain, mode])

  useEffect(() => {
    if (availableTypes.length > 0 && !availableTypes.includes(store.transferType)) {
      store.setTransferType('standard')
    }
  }, [availableTypes])

  // Compute CCTP versions available on source and dest chains
  const srcVersions = useMemo(() => {
    if (store.sourceDomain == null) return [2]
    return getSupportedVersions(store.sourceDomain, mode)
  }, [store.sourceDomain, mode])

  const dstVersions = useMemo(() => {
    if (store.destDomain == null) return [2]
    return getSupportedVersions(store.destDomain, mode)
  }, [store.destDomain, mode])

  // Common versions between source and dest
  const commonVersions = useMemo(() => {
    return srcVersions.filter((v) => dstVersions.includes(v))
  }, [srcVersions, dstVersions])

  // Auto-select CCTP version (prefer v2)
  useEffect(() => {
    if (commonVersions.length > 0 && !commonVersions.includes(cctpVersion)) {
      setCctpVersion(commonVersions.includes(2) ? 2 : commonVersions[0])
    }
  }, [commonVersions])

  // Determine which wallet type is needed for source chain
  const srcChainType = store.sourceDomain != null ? getChainTypeForDomain(store.sourceDomain, mode) : null
  const dstChainType = store.destDomain != null ? getChainTypeForDomain(store.destDomain, mode) : null

  // Check if the right wallet is connected for each side
  const srcWalletReady = useMemo(() => {
    if (!srcChainType) return false
    if (srcChainType === 'evm') return !!wallet.evm
    if (srcChainType === 'solana') return !!wallet.solana
    if (srcChainType === 'aptos') return !!wallet.aptos
    if (srcChainType === 'sui') return !!wallet.sui
    if (srcChainType === 'stellar') return !!wallet.stellar
    return false
  }, [srcChainType, wallet.evm, wallet.solana, wallet.aptos, wallet.sui, wallet.stellar])

  const dstWalletReady = useMemo(() => {
    if (!dstChainType) return false
    if (dstChainType === 'evm') return !!wallet.evm
    if (dstChainType === 'solana') return !!wallet.solana
    if (dstChainType === 'aptos') return !!wallet.aptos
    if (dstChainType === 'sui') return !!wallet.sui
    if (dstChainType === 'stellar') return !!wallet.stellar
    return false
  }, [dstChainType, wallet.evm, wallet.solana, wallet.aptos, wallet.sui, wallet.stellar])

  // Address of the connected destination-chain wallet (if any)
  const destWalletAddress = useMemo(() => {
    if (!dstChainType) return ''
    if (dstChainType === 'evm') return wallet.evm?.address ?? ''
    if (dstChainType === 'solana') return wallet.solana?.address ?? ''
    if (dstChainType === 'aptos') return wallet.aptos?.address ?? ''
    if (dstChainType === 'sui') return wallet.sui?.address ?? ''
    if (dstChainType === 'stellar') return wallet.stellar?.address ?? ''
    return ''
  }, [dstChainType, wallet.evm, wallet.solana, wallet.aptos, wallet.sui, wallet.stellar])

  // Auto-fill destination address when destination chain changes and its wallet is connected.
  // Respects the custom-address checkbox: only override when checkbox is off.
  useEffect(() => {
    if (!useCustomDestAddress && dstWalletReady && destWalletAddress) {
      setDestAddress(destWalletAddress)
    }
  }, [store.destDomain, destWalletAddress, useCustomDestAddress, dstWalletReady])

  const handleCustomAddressToggle = (checked: boolean) => {
    setUseCustomDestAddress(checked)
    if (!checked && dstWalletReady && destWalletAddress) {
      // Unchecking "custom" restores the connected destination wallet address.
      setDestAddress(destWalletAddress)
    }
  }

  const ready =
    store.sourceDomain != null &&
    store.destDomain != null &&
    store.amount &&
    destAddress &&
    srcWalletReady &&
    dstWalletReady

  async function handleSubmit() {
    if (!ready || submitting) return
    reset()
    await startTransfer({
      sourceDomain: store.sourceDomain!,
      destDomain: store.destDomain!,
      amount: store.amount,
      destAddress,
      transferType: store.transferType,
      cctpVersion,
    })
  }

  // Button text logic
  function getButtonText(): string {
    switch (step) {
      case 'switching-chain': return 'Switching chain...'
      case 'approving': return 'Approve USDC in wallet...'
      case 'waiting-approval': return 'Waiting for approval confirmation...'
      case 'burning': return 'Confirm burn in wallet...'
      case 'waiting-burn': return 'Waiting for burn confirmation...'
      case 'registering': return 'Registering transaction...'
      case 'submitted': return 'Transfer submitted — check History for status'
      case 'switching-dest-chain': return 'Switching to destination chain...'
      case 'claiming': return 'Confirm claim in wallet...'
      case 'waiting-claim': return 'Waiting for claim confirmation...'
      case 'complete': return 'Transfer complete!'
      case 'error': return 'Failed — try again'
      default: {
        if (store.sourceDomain == null || store.destDomain == null) return 'Select Source & Destination'
        if (!srcWalletReady) return `Connect ${srcChainType ?? ''} Wallet (Source)`
        if (!dstWalletReady) return `Connect ${dstChainType ?? ''} Wallet (Destination)`
        if (!store.amount) return 'Enter Amount'
        if (!destAddress) return 'Enter Destination Address'
        return 'Create Transfer'
      }
    }
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Network mode badge */}
      {mode === 'testnet' && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
          Testnet mode — transactions use testnet USDC
        </div>
      )}

      {/* Chain selectors with swap button */}
      <div className="space-y-3 sm:space-y-0 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-end sm:gap-4">
        <ChainSelector
          value={store.sourceDomain}
          onChange={store.setSourceDomain}
          label="From"
          exclude={store.destDomain}
        />
        <button
          onClick={() => {
            const tmp = store.sourceDomain
            store.setSourceDomain(store.destDomain ?? 0)
            store.setDestDomain(tmp ?? 0)
          }}
          className="mx-auto rounded-full border border-gray-700 bg-gray-800 p-2 text-gray-400 transition hover:text-white"
        >
          <ArrowDownUp className="h-5 w-5 sm:rotate-0 rotate-90" />
        </button>
        <ChainSelector
          value={store.destDomain}
          onChange={store.setDestDomain}
          label="To"
          exclude={store.sourceDomain}
        />
      </div>

      {/* Wallet status indicators */}
      {store.sourceDomain != null && store.destDomain != null && (
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <div
            className={`flex items-center gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 text-[10px] sm:text-xs min-w-0 ${
              srcWalletReady
                ? 'bg-green-500/10 text-green-400'
                : 'bg-yellow-500/10 text-yellow-400'
            }`}
          >
            <Wallet className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" />
            <span className="truncate">
              {srcWalletReady
                ? `${srcChainType?.toUpperCase()} connected`
                : `Connect ${srcChainType ?? ''} wallet`}
            </span>
          </div>
          <div
            className={`flex items-center gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 text-[10px] sm:text-xs min-w-0 ${
              dstWalletReady
                ? 'bg-green-500/10 text-green-400'
                : 'bg-yellow-500/10 text-yellow-400'
            }`}
          >
            <Wallet className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0" />
            <span className="truncate">
              {dstWalletReady
                ? `${dstChainType?.toUpperCase()} connected`
                : `Connect ${dstChainType ?? ''} wallet`}
            </span>
          </div>
        </div>
      )}

      {/* Amount */}
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Amount (USDC)</label>
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={store.amount}
          onChange={(e) => store.setAmount(e.target.value)}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 sm:px-4 py-2.5 sm:py-3 font-mono text-xl sm:text-2xl text-white placeholder-gray-600 outline-none transition focus:border-brand-500"
        />
      </div>

      {/* Destination address */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-medium text-gray-400">Destination Address</label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-gray-400 hover:text-gray-300">
            <input
              type="checkbox"
              checked={useCustomDestAddress}
              onChange={(e) => handleCustomAddressToggle(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-700 text-brand-600 focus:ring-brand-500"
            />
            Use custom address
          </label>
        </div>
        <input
          type="text"
          placeholder="0x... or wallet address"
          value={destAddress}
          onChange={(e) => setDestAddress(e.target.value)}
          disabled={!useCustomDestAddress}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 sm:px-4 py-2.5 sm:py-3 font-mono text-sm text-white placeholder-gray-600 outline-none transition focus:border-brand-500 disabled:cursor-not-allowed disabled:bg-gray-900/50 disabled:text-gray-500"
        />
      </div>

      {/* Transfer type cards */}
      {availableTypes.length > 0 && (
        <div>
          <label className="mb-2 block text-xs font-medium text-gray-400">Transfer Type</label>
          <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
            {(Object.keys(TRANSFER_META) as TransferType[])
              .filter((t) => availableTypes.includes(t))
              .map((type) => {
                const meta = TRANSFER_META[type]
                const Icon = meta.icon
                const active = store.transferType === type
                return (
                  <button
                    key={type}
                    onClick={() => store.setTransferType(type)}
                    disabled={submitting}
                    className={`flex flex-col items-center gap-1.5 sm:gap-2 rounded-xl border p-3 sm:p-4 text-center transition ${
                      active
                        ? 'border-brand-500 bg-brand-500/10 text-white'
                        : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-xs sm:text-sm font-medium">{meta.label}</span>
                    <span className="hidden sm:block text-[10px] leading-tight opacity-70">{meta.desc}</span>
                  </button>
                )
              })}
          </div>
        </div>
      )}

      {/* CCTP Version selector */}
      {commonVersions.length > 1 && (
        <div>
          <label className="mb-2 block text-xs font-medium text-gray-400">CCTP Version</label>
          <div className="flex gap-2">
            {commonVersions.map((v) => (
              <button
                key={v}
                onClick={() => setCctpVersion(v)}
                disabled={submitting}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  cctpVersion === v
                    ? 'border-brand-500 bg-brand-500/10 text-white'
                    : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                CCTP v{v}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* CCTP version badge (single version) */}
      {commonVersions.length === 1 && store.sourceDomain != null && store.destDomain != null && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Layers className="h-3.5 w-3.5" />
          CCTP v{commonVersions[0]}
        </div>
      )}

      {/* Error */}
      {transferError && (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 sm:px-4 py-3 text-sm text-red-400 break-words">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {transferError}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!ready || submitting}
        className="w-full rounded-xl bg-brand-600 py-3 sm:py-4 text-sm sm:text-lg font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center gap-2"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {getButtonText()}
      </button>
    </div>
  )
}
