import { useState, useCallback } from 'react'
import { useEvmAdapter } from './cctp/evm'
import { useAptosAdapter } from './cctp/aptos'
import { useStellarAdapter } from './cctp/stellar'
import type { ChainAdapter } from './cctp/types'
import { getChainByDomain } from '../config/chains'
import { useNetworkMode } from '../stores/networkMode'
import { useWalletStore } from '../stores/walletStore'
import type { TransferType } from '../types'

function formatWalletError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()

  // User rejection patterns across wallets
  if (
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('rejected the request') ||
    lower.includes('request rejected') ||
    lower.includes('user cancelled') ||
    lower.includes('user canceled') ||
    lower.includes('transaction was cancelled') ||
    lower.includes('transaction was canceled') ||
    lower.includes('user dismissed') ||
    lower.includes('action rejected')
  ) {
    return `${fallback}: User rejected the request`
  }

  // Chain switch / network errors
  if (
    lower.includes('unrecognized chain') ||
    lower.includes('chain not configured') ||
    lower.includes('invalid chain') ||
    lower.includes('wallet_network_error') ||
    lower.includes('user rejected the request') === false && lower.includes('switch chain')
  ) {
    return `${fallback}: Network error — please switch chain manually in your wallet`
  }

  // Insufficient funds
  if (
    lower.includes('insufficient funds') ||
    lower.includes('insufficient balance')
  ) {
    return `${fallback}: Insufficient funds for gas`
  }

  // Fallback: keep first line or truncate to avoid dumping full viem object
  const short = raw.split('\n')[0].slice(0, 160)
  return short.length < raw.length ? `${fallback}: ${short}…` : `${fallback}: ${short}`
}

export type TransferStep =
  | 'idle'
  | 'switching-chain'
  | 'approving'
  | 'waiting-approval'
  | 'burning'
  | 'waiting-burn'
  | 'registering'
  | 'submitted'
  | 'switching-dest-chain'
  | 'claiming'
  | 'waiting-claim'
  | 'complete'
  | 'error'

export interface CctpTransferParams {
  sourceDomain: number
  destDomain: number
  amount: string
  destAddress: string
  transferType: TransferType
  cctpVersion: number
}

export function useCctpTransfer() {
  const [step, setStep] = useState<TransferStep>('idle')
  const [error, setError] = useState<string | null>(null)
  const [sourceTxHash, setSourceTxHash] = useState<string | null>(null)
  const [destTxHash, setDestTxHash] = useState<string | null>(null)

  const evmAdapter = useEvmAdapter()
  const aptosAdapter = useAptosAdapter()
  const stellarAdapter = useStellarAdapter()
  const mode = useNetworkMode((s) => s.mode)
  const wallet = useWalletStore()

  function getAdapter(chainType: string): ChainAdapter {
    switch (chainType) {
      case 'evm': return evmAdapter
      case 'aptos': return aptosAdapter
      case 'stellar': return stellarAdapter
      default: throw new Error(`${chainType} chain type not supported for CCTP transfers yet`)
    }
  }

  const startTransfer = useCallback(
    async (params: CctpTransferParams) => {
      const {
        sourceDomain,
        destDomain,
        amount,
        destAddress,
        transferType,
        cctpVersion,
      } = params

      const srcChain = getChainByDomain(sourceDomain, mode)
      if (!srcChain) {
        setError('Invalid source chain')
        setStep('error')
        return
      }

      const chainWallet = srcChain.chain_type === 'evm' ? wallet.evm
        : srcChain.chain_type === 'aptos' ? wallet.aptos
        : srcChain.chain_type === 'stellar' ? wallet.stellar
        : srcChain.chain_type === 'solana' ? wallet.solana
        : srcChain.chain_type === 'sui' ? wallet.sui
        : null
      if (!chainWallet) {
        setError(`Connect your ${srcChain.chain_type} wallet first`)
        setStep('error')
        return
      }

      let adapter: ChainAdapter
      try {
        adapter = getAdapter(srcChain.chain_type)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unsupported chain type')
        setStep('error')
        return
      }

      try {
        // Step 1: Switch to source chain
        setStep('switching-chain')
        try {
          await adapter.switchChain(sourceDomain)
        } catch (e) {
          console.error('[switchChain]', e)
          setError(`Please switch to ${srcChain.name} in your wallet`)
          setStep('error')
          return
        }

        // Step 2: Approve USDC (no-op for Aptos)
        setStep('approving')
        try {
          await adapter.approveUsdc(srcChain, amount, cctpVersion)
        } catch (e) {
          console.error('[approveUsdc]', e)
          setError(formatWalletError(e, 'Approve failed'))
          setStep('error')
          return
        }

        // Step 3: Burn via depositForBurn
        setStep('burning')
        const destChain = getChainByDomain(destDomain, mode)
        let txHash: string
        try {
          txHash = await adapter.burnUsdc({
            chainConfig: srcChain,
            amount,
            destDomain,
            destAddress,
            destChainType: destChain?.chain_type,
            cctpVersion,
            transferType,
          })
        } catch (burnErr) {
          console.error('[burnUsdc]', burnErr)
          setError(formatWalletError(burnErr, 'Burn failed'))
          setStep('error')
          return
        }

        // Step 4: Wait for source tx receipt
        setStep('waiting-burn')
        const receipt = await adapter.waitForSourceTx(txHash, srcChain)
        setSourceTxHash(receipt.transactionHash ?? txHash)

        const sourceAddress = srcChain.chain_type === 'evm'
          ? (receipt.from as string)
          : chainWallet.address

        // Step 5: Register with backend
        setStep('registering')
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_domain: sourceDomain,
            dest_domain: destDomain,
            source_tx_hash: receipt.transactionHash ?? txHash,
            source_address: sourceAddress,
            dest_address: destAddress,
            amount,
            transfer_type: transferType,
            cctp_version: cctpVersion,
            network_mode: mode,
          }),
        })

        if (!res.ok) {
          const text = await res.text()
          throw new Error(`Backend error: ${text}`)
        }

        const { transaction } = await res.json()
        setSourceTxHash(transaction.source_tx_hash)

        // Done — backend poller handles attestation in background.
        // User can check status and claim from the transaction status page.
        setStep('submitted')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Transfer failed')
        setStep('error')
      }
    },
    [mode, wallet, evmAdapter, aptosAdapter, stellarAdapter],
  )

  const claimOnDestination = useCallback(
    async (destDomain: number, attestationHex: string, messageHex: string, cctpVersion: number, txHash?: string) => {
      const destChain = getChainByDomain(destDomain, mode)
      if (!destChain) {
        setError('Invalid destination chain')
        setStep('error')
        return
      }

      let adapter: ChainAdapter
      try {
        adapter = getAdapter(destChain.chain_type)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unsupported destination chain type')
        setStep('error')
        return
      }

      try {
        setStep('switching-dest-chain')
        try {
          await adapter.switchChain(destDomain)
        } catch {
          setError('Please switch to the destination chain in your wallet')
          setStep('error')
          return
        }

        setStep('claiming')
        let claimTxHash: string
        try {
          claimTxHash = await adapter.claimOnDest({
            destDomain,
            message: messageHex,
            attestation: attestationHex,
            cctpVersion,
            destChainType: destChain.chain_type,
          })
        } catch (claimErr) {
          console.error('[claimOnDest]', claimErr)
          setError(formatWalletError(claimErr, 'Claim failed'))
          setStep('error')
          return
        }

        // Some wallet connectors resolve instead of throwing on rejection.
        // Treat a missing/empty hash as a failure so the UI never shows "complete".
        if (!claimTxHash || typeof claimTxHash !== 'string') {
          setError('Claim failed: wallet did not return a transaction hash')
          setStep('error')
          return
        }

        setDestTxHash(claimTxHash)
        setStep('complete')

        // Report claim to backend — use passed txHash or internal sourceTxHash
        const hash = txHash ?? sourceTxHash
        if (hash) {
          fetch(`/api/transactions/${hash}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dest_tx_hash: claimTxHash }),
          }).catch(() => {})
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Claim failed')
        setStep('error')
      }
    },
    [mode, sourceTxHash, evmAdapter, aptosAdapter, stellarAdapter],
  )

  const reset = useCallback(() => {
    setStep('idle')
    setError(null)
    setSourceTxHash(null)
    setDestTxHash(null)
  }, [])

  return {
    step,
    error,
    sourceTxHash,
    destTxHash,
    startTransfer,
    claimOnDestination,
    reset,
  }
}
