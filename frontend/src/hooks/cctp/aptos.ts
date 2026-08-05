import { useCallback } from 'react'
import { useWallet, type InputTransactionData } from '@aptos-labs/wallet-adapter-react'
import { MoveVector, U64, U32, AccountAddress } from '@aptos-labs/ts-sdk'
import { getCctpContracts } from '../../config/chains'
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

/**
 * CCTP mint_recipient for a non-Move destination (e.g. EVM) must be a
 * 32-byte (64 hex) address. EVM addresses are 20 bytes, so left-pad them.
 */
function normalizeMintRecipient(addr: string): string {
  const clean = addr.replace(/^0x/i, '')
  if (clean.length === 64) return `0x${clean}`
  return `0x${clean.padStart(64, '0')}`
}

// Pre-compiled CCTP V1 Move script bytecode from
// https://github.com/circlefin/aptos-cctp/tree/master/typescript/example/precompiled-move-scripts
// On Aptos neither deposit_for_burn nor receive_message is a plain entry
// function callable with simple args: deposit_for_burn takes a FungibleAsset,
// and receive_message returns a hot-potato Receipt that must be consumed in the
// same transaction. Both are executed via these pre-compiled scripts.
const BURN_SCRIPT_BYTECODE: Record<string, string> = {
  testnet:
    'oRzrCwcAAAoHAQAIAggOAxYUBCoEBS4wB16HAQjlAUAAAAABAAIBAwAEAAABBQcBAAEABgsAAQcDBAEIAQIIBQYBCAEDCQgJAAEAAgECBQYMAw4FBQIIAAsBAQgCAQgCAQUBCwEBCQADBgwLAQEJAAMBCAAABAYMCAAOBQEDDmZ1bmdpYmxlX2Fzc2V0Bm9iamVjdBZwcmltYXJ5X2Z1bmdpYmxlX3N0b3JlD3Rva2VuX21lc3Nlbmdlcg1GdW5naWJsZUFzc2V0Bk9iamVjdAhNZXRhZGF0YRFhZGRyZXNzX3RvX29iamVjdAh3aXRoZHJhdxBkZXBvc2l0X2Zvcl9idXJuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFfm5N0Gd2pCqBsGDa3hH9lu74/EhdWd1jcJIi+MaR3uQAAAQ8LBDgADAYKAAsGCwE4AQwFCwALBQsCCwMRAgEC',
  mainnet:
    'oRzrCwcAAAoHAQAIAggOAxYUBCoEBS4wB16HAQjlAUAAAAABAAIBAwAEAAABBQcBAAEABgsAAQcDBAEIAQIIBQYBCAEDCQgJAAEAAgECBQYMAw4FBQIIAAsBAQgCAQgCAQUBCwEBCQADBgwLAQEJAAMBCAAABAYMCAAOBQEDDmZ1bmdpYmxlX2Fzc2V0Bm9iamVjdBZwcmltYXJ5X2Z1bmdpYmxlX3N0b3JlD3Rva2VuX21lc3Nlbmdlcg1GdW5naWJsZUFzc2V0Bk9iamVjdAhNZXRhZGF0YRFhZGRyZXNzX3RvX29iamVjdAh3aXRoZHJhdxBkZXBvc2l0X2Zvcl9idXJuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGbzmc097Y+g1EI472MNnQ9Rwn+Q19EeRkYgB0JiWQKnQAAAQ8LBDgADAYKAAsGCwE4AQwFCwALBQsCCwMRAgEC',
}

const RECEIVE_SCRIPT_BYTECODE: Record<string, string> = {
  testnet:
    'oRzrCwcAAAoGAQAEAgQEAwgMBRQWBypTCH1AAAABAQACAAAAAwIDAAEBBAMEAAEDBgwKAgoCAAMGDAYKAgYKAgEIAAEBE21lc3NhZ2VfdHJhbnNtaXR0ZXIPdG9rZW5fbWVzc2VuZ2VyB1JlY2VpcHQPcmVjZWl2ZV9tZXNzYWdlFmhhbmRsZV9yZWNlaXZlX21lc3NhZ2UIHobOv0V6DGAE81vWSKJ5Rpj1Lg3eCaSGGdzT1Mwj2V+bk3QZ3akKoGwYNreEf2W7vj8SF1Z3WNwkiL4xpHe5AAABBwsADgEOAhEAEQEBAg==',
  mainnet:
    'oRzrCwcAAAoGAQAEAgQEAwgMBRQWBypTCH1AAAABAQACAAAAAwIDAAEBBAMEAAEDBgwKAgoCAAMGDAYKAgYKAgEIAAEBE21lc3NhZ2VfdHJhbnNtaXR0ZXIPdG9rZW5fbWVzc2VuZ2VyB1JlY2VpcHQPcmVjZWl2ZV9tZXNzYWdlFmhhbmRsZV9yZWNlaXZlX21lc3NhZ2UXfhd1GCDktDcYc8qMMCeb5jvepjuI7Q8iOcLuoQ8XcpvOZzT3tj6DUQjjvYw2dD1HCf5DX0R5GRiAHQmJZAqdAAABBwsADgEOAhEAEQEBAg==',
}

function decodeBytecode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
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

      // Aptos is CCTP V1-only. deposit_for_burn takes a FungibleAsset, so it is
      // executed via the pre-compiled Move script, not an entry function call.
      const bytecode = BURN_SCRIPT_BYTECODE[mode]
      if (!bytecode) throw new Error(`No CCTP v1 deposit_for_burn script for network "${mode}"`)

      const payload: InputTransactionData = {
        data: {
          bytecode: decodeBytecode(bytecode),
          functionArguments: [
            new U64(amountRaw),
            new U32(destDomain),
            AccountAddress.from(normalizeMintRecipient(destAddress)),
            AccountAddress.from(chainConfig.usdc_address),
          ],
        },
      }

      const result = await signAndSubmitTransaction(payload)
      return result.hash
    },
    [signAndSubmitTransaction, account, connected, mode],
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

      const contracts = getCctpContracts(destDomain, 1, mode as 'mainnet' | 'testnet')
      if (!contracts) throw new Error(`No CCTP v1 contracts configured for domain ${destDomain}`)

      // Aptos is CCTP V1-only. receive_message is NOT an entry function — it
      // returns a hot-potato Receipt that must be consumed by
      // handle_receive_message + complete_receive_message in the SAME
      // transaction, which can only be done via a pre-compiled Move script.
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
    [signAndSubmitTransaction, account, connected, mode],
  )

  return { switchChain, approveUsdc, burnUsdc, waitForSourceTx, claimOnDest }
}
