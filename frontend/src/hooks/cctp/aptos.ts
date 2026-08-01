import { useCallback } from 'react'
import { useWallet, type InputTransactionData } from '@aptos-labs/wallet-adapter-react'
import { getChainByDomain } from '../../config/chains'
import { useNetworkMode } from '../../stores/networkMode'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig } from '../../types'

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16))
  }
  return bytes
}

export function useAptosAdapter(): ChainAdapter {
  const { signAndSubmitTransaction, account, connected } = useWallet()
  const mode = useNetworkMode((s) => s.mode)

  const switchChain = useCallback(async (_domain: number) => {
    // Aptos has a single network — no EVM-style chain switching needed
  }, [])

  const approveUsdc = useCallback(async (_chainConfig: ChainConfig, _amount: string, _cctpVersion?: number) => {
    // Aptos CCTP: deposit_for_burn handles the coin transfer directly
  }, [])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress }: SourceBurnParams): Promise<string> => {
      if (!connected || !account?.address) {
        throw new Error('Aptos wallet not connected')
      }

      const amountRaw = Math.floor(parseFloat(amount) * 1_000_000)

      const payload: InputTransactionData = {
        data: {
          function: `${chainConfig.token_messenger_v2}::token_messenger::deposit_for_burn`,
          typeArguments: [chainConfig.usdc_address],
          functionArguments: [
            amountRaw.toString(),
            destDomain.toString(),
            destAddress,
          ],
        },
      }

      const result = await signAndSubmitTransaction(payload)
      return result.hash
    },
    [signAndSubmitTransaction, account, connected],
  )

  const waitForSourceTx = useCallback(
    async (txHash: string, chainConfig: ChainConfig): Promise<any> => {
      const rpcUrl = chainConfig.rpc_url
      const deadline = Date.now() + 120_000

      while (Date.now() < deadline) {
        try {
          const resp = await fetch(`${rpcUrl}/v1/transactions/by_hash/${txHash}`)
          if (resp.ok) {
            const tx = await resp.json()
            if (tx.type === 'user_transaction') return tx
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 2000))
      }

      throw new Error('Aptos transaction timed out')
    },
    [],
  )

  const claimOnDest = useCallback(
    async ({ destDomain, message, attestation }: ClaimParams): Promise<string> => {
      if (!connected || !account?.address) {
        throw new Error('Aptos wallet not connected')
      }

      const destChain = getChainByDomain(destDomain, mode)
      if (!destChain) throw new Error('Invalid destination chain')

      const payload: InputTransactionData = {
        data: {
          function: `${destChain.message_transmitter_v2}::message_transmitter::receive_message`,
          typeArguments: [],
          functionArguments: [
            hexToBytes(message),
            hexToBytes(attestation),
          ],
        },
      }

      const result = await signAndSubmitTransaction(payload)
      return result.hash
    },
    [signAndSubmitTransaction, account, connected, mode],
  )

  return { switchChain, approveUsdc, burnUsdc, waitForSourceTx, claimOnDest }
}
