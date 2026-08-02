import { useState, useCallback } from 'react'
import { useEvmAdapter } from './cctp/evm'
import { useAptosAdapter } from './cctp/aptos'
import { useStellarAdapter } from './cctp/stellar'
import type { ChainAdapter } from './cctp/types'
import { getChainByDomain } from '../config/chains'
import { useNetworkMode } from '../stores/networkMode'
import { useWalletState } from '@xansfer/wallet-connect'
import * as api from '../lib/api'
import type { TransferType } from '../types'

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

/** Shrink wallet/viem errors for the UI — a user-rejected request just shows a short note. */
function friendlyError(e: unknown): string {
  const err = e as { code?: unknown; name?: string; message?: string }
  const isRejected =
    err?.code === 4001 ||
    err?.name === 'UserRejectedRequestError' ||
    /(user rejected|request rejected|user denied|user cancelled|connection cancelled)/i.test(
      String(err?.message ?? ''),
    )
  if (isRejected) return '您在钱包中拒绝了此操作'
  return e instanceof Error ? e.message : String(e)
}

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
  const wallet = useWalletState()

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
          const msg = friendlyError(e)
          console.error('[approveUsdc]', msg)
          setError(`Approve failed: ${msg}`)
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
          const msg = friendlyError(burnErr)
          console.error('[burnUsdc]', msg)
          setError(`Burn failed: ${msg}`)
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

        // Step 5: Register with backend (falls back to local storage when the
        // backend is unreachable — the frontend works standalone).
        setStep('registering')
        const { transaction } = await api.createTransaction(
          {
            source_domain: sourceDomain,
            dest_domain: destDomain,
            source_tx_hash: receipt.transactionHash ?? txHash,
            source_address: sourceAddress,
            dest_address: destAddress,
            amount,
            transfer_type: transferType,
            cctp_version: cctpVersion,
            network_mode: mode,
          },
          mode,
        )
        setSourceTxHash(transaction.source_tx_hash)

        // Done — backend poller handles attestation in background.
        // User can check status and claim from the transaction status page.
        setStep('submitted')
      } catch (e) {
        setError(friendlyError(e))
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
          const msg = friendlyError(claimErr)
          console.error('[claimOnDest]', msg)
          setError(`Claim failed: ${msg}`)
          setStep('error')
          return
        }

        setDestTxHash(claimTxHash)
        setStep('complete')

        // Report claim to backend — use passed txHash or internal sourceTxHash.
        // Falls back to local storage when the backend is unreachable.
        const hash = txHash ?? sourceTxHash
        if (hash) {
          api.reportClaim(hash, claimTxHash, mode).catch(() => {})
        }
      } catch (e) {
        setError(friendlyError(e))
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
