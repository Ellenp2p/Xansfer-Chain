import { useCallback } from 'react'
import { useWallet, type InputTransactionData } from '@aptos-labs/wallet-adapter-react'
import { MoveVector, U64, U32, AccountAddress } from '@aptos-labs/ts-sdk'
import { useNetworkMode } from '../../stores/networkMode'
import { assertDestinationAddress } from '../../lib/address'
import { buildCctpForwarderHookData, contractStrKeyToBytes32, normalizeMintRecipient } from '../../lib/cctpEncoding'
import {
  BURN_SCRIPT_BYTECODE,
  RECEIVE_SCRIPT_BYTECODE,
  BURN_SCRIPT_BYTECODE_V2,
  RECEIVE_SCRIPT_BYTECODE_V2,
  BURN_SCRIPT_BYTECODE_V2_WITH_HOOK,
} from '../../config/aptosScripts'
import { parseUsdcUnits, fetchCircleMaxFee } from '../../lib/fees'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig, ChainType } from '../../types'

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16))
  }
  return bytes
}

const ZERO_ADDRESS = '0x' + '0'.repeat(64)

// CCTP Forwarder contract addresses on Stellar.
const STELLAR_CCTP_FORWARDER: Record<string, string> = {
  testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  mainnet: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
}

function decodeBytecode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function useAptosAdapter(): ChainAdapter {
  const { signAndSubmitTransaction, account, connected, network } = useWallet()
  const mode = useNetworkMode((s) => s.mode)

  const assertWalletNetwork = useCallback(() => {
    if (network && network.name !== mode) {
      throw new Error(`Aptos wallet is on "${network.name}" but the app is in ${mode} mode ??switch the wallet network and retry`)
    }
  }, [network, mode])

  const switchChain = useCallback(async (_domain: number) => {
    // Aptos has a single network ??no EVM-style chain switching needed
  }, [])

  const approveUsdc = useCallback(async (_chainConfig: ChainConfig, _amount: string, _cctpVersion?: number) => {
    // Aptos CCTP: deposit_for_burn handles the coin transfer directly
  }, [])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, destChainType, cctpVersion = 2, transferType }: SourceBurnParams): Promise<string> => {
      if (!connected || !account?.address) {
        throw new Error('Aptos wallet not connected')
      }
      assertWalletNetwork()
      assertDestinationAddress(destAddress, destChainType as ChainType, mode)

      const amountUnits = parseUsdcUnits(amount, chainConfig.usdc_decimals ?? 6)
      const isFast = transferType === 'fast'
      const minFinalityThreshold = isFast ? 1000 : 2000

      // Query Circle fee API (v2 only; v1 does not use maxFee).
      // minimumFee is in basis points of the burn amount.
      let maxFee = 0n
      if (cctpVersion === 2) {
        maxFee = await fetchCircleMaxFee({
          mode,
          srcDomain: chainConfig.domain,
          destDomain,
          finalityThreshold: minFinalityThreshold,
          amountUnits,
        })
      }

      if (cctpVersion === 2) {
        const isStellarDest = destChainType === 'stellar' || destAddress.startsWith('G')

        // Aptos ??Stellar uses CCTP Forwarder + hook data.
        if (isStellarDest) {
          const forwarderAddr = STELLAR_CCTP_FORWARDER[mode]
          if (!forwarderAddr) throw new Error('Stellar CCTP Forwarder not configured for this network')

          const forwarderAptosAddr = AccountAddress.from(contractStrKeyToBytes32(forwarderAddr))
          const hookData = buildCctpForwarderHookData(destAddress)
          const bytecode = BURN_SCRIPT_BYTECODE_V2_WITH_HOOK[mode]
          if (!bytecode) throw new Error(`No CCTP v2 deposit_for_burn_with_hook script for network "${mode}"`)

          const payload: InputTransactionData = {
            data: {
              bytecode: decodeBytecode(bytecode),
              functionArguments: [
                new U64(amountUnits),
                new U32(destDomain),
                forwarderAptosAddr,        // mintRecipient = CCTP Forwarder
                forwarderAptosAddr,        // destinationCaller = CCTP Forwarder
                AccountAddress.from(chainConfig.usdc_address),
                new U64(maxFee),
                new U32(minFinalityThreshold),
                MoveVector.U8(hexToBytes(hookData)),
              ],
            },
          }

          const result = await signAndSubmitTransaction(payload)
          return result.hash
        }

        const bytecode = BURN_SCRIPT_BYTECODE_V2[mode]
        if (!bytecode) throw new Error(`No CCTP v2 deposit_for_burn script for network "${mode}"`)

        const payload: InputTransactionData = {
          data: {
            bytecode: decodeBytecode(bytecode),
            functionArguments: [
              new U64(amountUnits),
              new U32(destDomain),
              AccountAddress.from(normalizeMintRecipient(destAddress)),
              AccountAddress.from(ZERO_ADDRESS),
              AccountAddress.from(chainConfig.usdc_address),
              new U64(maxFee),
              new U32(minFinalityThreshold),
            ],
          },
        }

        const result = await signAndSubmitTransaction(payload)
        return result.hash
      }

      // CCTP v1: deposit_for_burn takes a FungibleAsset, so it is executed via a
      // pre-compiled Move script, not a plain entry function call.
      const bytecode = BURN_SCRIPT_BYTECODE[mode]
      if (!bytecode) throw new Error(`No CCTP v1 deposit_for_burn script for network "${mode}"`)

      const payload: InputTransactionData = {
        data: {
          bytecode: decodeBytecode(bytecode),
          functionArguments: [
            new U64(amountUnits),
            new U32(destDomain),
            AccountAddress.from(normalizeMintRecipient(destAddress)),
            AccountAddress.from(chainConfig.usdc_address),
          ],
        },
      }

      const result = await signAndSubmitTransaction(payload)
      return result.hash
    },
    [signAndSubmitTransaction, account, connected, mode, assertWalletNetwork],
  )

  const waitForSourceTx = useCallback(
    async (txHash: string, chainConfig: ChainConfig): Promise<any> => {
      // rpc_url already includes /v1 (e.g. https://fullnode.testnet.aptoslabs.com/v1)
      const base = chainConfig.rpc_url.endsWith('/v1') ? chainConfig.rpc_url : `${chainConfig.rpc_url}/v1`
      const deadline = Date.now() + 120_000

      while (Date.now() < deadline) {
        try {
          const resp = await fetch(`${base}/transactions/by_hash/${txHash}`)
          if (resp.ok) {
            const tx = await resp.json()
            if (tx.type === 'user_transaction') {
              if (!tx.success) {
                throw new Error(`Aptos transaction failed: ${tx.vm_status ?? 'unknown VM status'}`)
              }
              return tx
            }
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
    async ({ destDomain: _destDomain, message, attestation, cctpVersion = 2 }: ClaimParams): Promise<string> => {
      if (!connected || !account?.address) {
        throw new Error('Aptos wallet not connected')
      }
      assertWalletNetwork()

      // receive_message is NOT an entry function ??it returns a hot-potato
      // Receipt that must be consumed by prepare_mint + handler::mint in the
      // SAME transaction, which can only be done via a pre-compiled Move script.
      if (cctpVersion === 2) {
        const bytecode = RECEIVE_SCRIPT_BYTECODE_V2[mode]
        if (!bytecode) throw new Error(`No CCTP v2 receive script for network "${mode}"`)

        const payload: InputTransactionData = {
          data: {
            bytecode: decodeBytecode(bytecode),
            functionArguments: [
              MoveVector.U8(hexToBytes(message)),
              MoveVector.U8(hexToBytes(attestation)),
            ],
          },
        }

        const result = await signAndSubmitTransaction(payload)
        return result.hash
      }

      const bytecode = RECEIVE_SCRIPT_BYTECODE[mode]
      if (!bytecode) throw new Error(`No CCTP v1 receive script for network "${mode}"`)

      const payload: InputTransactionData = {
        data: {
          bytecode: decodeBytecode(bytecode),
          functionArguments: [
            MoveVector.U8(hexToBytes(message)),
            MoveVector.U8(hexToBytes(attestation)),
          ],
        },
      }

      const result = await signAndSubmitTransaction(payload)
      return result.hash
    },
    [signAndSubmitTransaction, account, connected, mode, assertWalletNetwork],
  )

  return { switchChain, approveUsdc, burnUsdc, waitForSourceTx, claimOnDest }
}
