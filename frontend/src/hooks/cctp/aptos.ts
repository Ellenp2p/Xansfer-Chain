import { useCallback } from 'react'
import { useWallet, type InputTransactionData } from '@aptos-labs/wallet-adapter-react'
import { MoveVector, U64, U32, AccountAddress } from '@aptos-labs/ts-sdk'
import { toHex, stringToBytes } from 'viem'
import { useNetworkMode } from '../../stores/networkMode'
import { assertDestinationAddress } from '../../lib/address'
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

/**
 * CCTP mint_recipient for a non-Move destination (e.g. EVM) must be a
 * 32-byte (64 hex) address. EVM addresses are 20 bytes, so left-pad them.
 */
function normalizeMintRecipient(addr: string): string {
  const clean = addr.replace(/^0x/i, '')
  if (clean.length === 64) return `0x${clean}`
  return `0x${clean.padStart(64, '0')}`
}

const ZERO_ADDRESS = '0x' + '0'.repeat(64)

// Stellar StrKey decoding helpers for Aptos → Stellar CCTP forwarding.
const STELLAR_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function stellarStrKeyDecode(strkey: string): Uint8Array {
  let bits = 0
  let value = 0
  const output: number[] = []
  for (const char of strkey.toUpperCase()) {
    const idx = STELLAR_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error(`Invalid character in Stellar strkey: ${char}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(output)
}

/** Convert Stellar contract strkey (C...) to bytes32 hex. */
function contractStrKeyToBytes32(strkey: string): string {
  if (!strkey.startsWith('C') || strkey.length !== 56) {
    throw new Error(`Invalid Stellar contract strkey: ${strkey}`)
  }
  const decoded = stellarStrKeyDecode(strkey)
  const contractId = decoded.slice(1, 33)
  return toHex(contractId, { size: 32 })
}

/**
 * Build hookData for CCTP Forwarder.
 * Layout: [24-byte zero padding][4-byte hook version (0)][4-byte recipient length][recipient UTF-8 bytes]
 */
function buildCctpForwarderHookData(forwardRecipient: string): string {
  const recipientBytes = stringToBytes(forwardRecipient)
  const hookData = new Uint8Array(32 + recipientBytes.length)
  hookData[28] = (recipientBytes.length >>> 24) & 0xff
  hookData[29] = (recipientBytes.length >>> 16) & 0xff
  hookData[30] = (recipientBytes.length >>> 8) & 0xff
  hookData[31] = recipientBytes.length & 0xff
  hookData.set(recipientBytes, 32)
  return toHex(hookData)
}

// CCTP Forwarder contract addresses on Stellar.
const STELLAR_CCTP_FORWARDER: Record<string, string> = {
  testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  mainnet: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
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

// CCTP V2 scripts from
// https://github.com/circlefin/aptos-cctp/tree/master/typescript/example/precompiled-move-scripts/v2
const BURN_SCRIPT_BYTECODE_V2: Record<string, string> = {
  testnet:
    'oRzrCwkAAAoIAQAKAgoSAxwiBD4EBUI/B4EBsAEIsQKAARCxAx8BAwEEAQcCCgMMAAILAAEGBwEAAQAJAAADCwAAAQUDBAEIAQEBAggFBgEIAQEBAwEICQABAQEEDQkBAAEBAQACAQIIBgwDDgUFBQMOAAEIAAEFAQsBAQkAAwYMCwEBCQADAQgCAQIIBgwIAg4FBQMOCgICCAMIAgMLAQEIAAgCCAMIPFNFTEY+XzAQZGVwb3NpdF9mb3JfYnVybghNZXRhZGF0YQ5mdW5naWJsZV9hc3NldAZvYmplY3QRYWRkcmVzc190b19vYmplY3QGT2JqZWN0FnByaW1hcnlfZnVuZ2libGVfc3RvcmUId2l0aGRyYXcNRnVuZ2libGVBc3NldBZ0b2tlbl9tZXNzZW5nZXJfbWludGVyC0J1cm5SZWNlaXB0B2hhbmRsZXIEYnVybv//////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHGAdP3uJt3tVJybV2Ey/Km0+inOtu+4/CfrRaaMoa7WeXRnE624eQsVDWQH8YVP9GfZhVlG+Dmzv4PByJtSmhGFGNvbXBpbGF0aW9uX21ldGFkYXRhCQADMi4wAzIuMwAAAQoTCwU4AAwICgALCAsBOAEMCQsACwkLAgsDCwQLBgsHQAcAAAAAAAAAABECEQMC',
  mainnet:
    'oRzrCwkAAAoIAQAKAgoSAxwiBD4EBUI/B4EBsAEIsQKAARCxAx8BAwEEAQcCCgMMAAILAAEGBwEAAQAJAAADCwAAAQUDBAEIAQEBAggFBgEIAQEBAwEICQABAQEEDQkBAAEBAQACAQIIBgwDDgUFBQMOAAEIAAEFAQsBAQkAAwYMCwEBCQADAQgCAQIIBgwIAg4FBQMOCgICCAMIAgMLAQEIAAgCCAMIPFNFTEY+XzAQZGVwb3NpdF9mb3JfYnVybghNZXRhZGF0YQ5mdW5naWJsZV9hc3NldAZvYmplY3QRYWRkcmVzc190b19vYmplY3QGT2JqZWN0FnByaW1hcnlfZnVuZ2libGVfc3RvcmUId2l0aGRyYXcNRnVuZ2libGVBc3NldBZ0b2tlbl9tZXNzZW5nZXJfbWludGVyC0J1cm5SZWNlaXB0B2hhbmRsZXIEYnVybv//////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFVHjJ4F5PDC/FYDRHk9RcejQaMPUXDpbIK4kC/2tma+CuWP4qii4FdLodb2FoaAdXy00bwj1ufz4lTx3aAc1ryFGNvbXBpbGF0aW9uX21ldGFkYXRhCQADMi4wAzIuMwAAAQoTCwU4AAwICgALCAsBOAEMCQsACwkLAgsDCwQLBgsHQAcAAAAAAAAAABECEQMC',
}

const RECEIVE_SCRIPT_BYTECODE_V2: Record<string, string> = {
  testnet:
    'oRzrCwkAAAoHAQAGAgYIAw4YBSYXBz1yCK8BgAEQrwIfAQICBAMHAAMAAAEGAAAAAQIDAAEBAQEFAwQAAQEBAggEAQABAQEDBgwKAgoCAAMGDAYKAgYKAgEIAAEIAQg8U0VMRj5fMw9yZWNlaXZlX21lc3NhZ2UTbWVzc2FnZV90cmFuc21pdHRlcgdSZWNlaXB0FnRva2VuX21lc3Nlbmdlcl9taW50ZXIMcHJlcGFyZV9taW50C01pbnRSZWNlaXB0B2hhbmRsZXIEbWludP//////////////////////////////////////////pYLcAZrhewSF99P8xMqFvqeUHjtwpLaCzqInWfNucR/GAdP3uJt3tVJybV2Ey/Km0+inOtu+4/CfrRaaMoa7WeXRnE624eQsVDWQH8YVP9GfZhVlG+Dmzv4PByJtSmhGFGNvbXBpbGF0aW9uX21ldGFkYXRhCQADMi4wAzIuMwAAAQEHCwAOAQ4CEQARARECAg==',
  mainnet:
    'oRzrCwkAAAoHAQAGAgYIAw4YBSYXBz1yCK8BgAEQrwIfAQICBAMHAAMAAAEGAAAAAQIDAAEBAQEFAwQAAQEBAggEAQABAQEDBgwKAgoCAAMGDAYKAgYKAgEIAAEIAQg8U0VMRj5fMw9yZWNlaXZlX21lc3NhZ2UTbWVzc2FnZV90cmFuc21pdHRlcgdSZWNlaXB0FnRva2VuX21lc3Nlbmdlcl9taW50ZXIMcHJlcGFyZV9taW50C01pbnRSZWNlaXB0B2hhbmRsZXIEbWludP//////////////////////////////////////////Gz9tdJy4NUUSAvmhky5JAUJm9+PVFhGpp2PRVstL2vZVHjJ4F5PDC/FYDRHk9RcejQaMPUXDpbIK4kC/2tma+CuWP4qii4FdLodb2FoaAdXy00bwj1ufz4lTx3aAc1ryFGNvbXBpbGF0aW9uX21ldGFkYXRhCQADMi4wAzIuMwAAAQEHCwAOAQ4CEQARARECAg==',
}

const BURN_SCRIPT_BYTECODE_V2_WITH_HOOK: Record<string, string> = {
  testnet:
    'oRzrCwkAAAoIAQAMAgwSAx4qBEgEBUxDB48B4gEI8QKAARDxAx8BAwEEAQcCCgMNAQ8AAgsAAQYHAQABAAkAAAMMAAABBQQFAQgBAQECCAYHAQgBAQEDCwgJAAEBAQQOCQEAAQEBBRAKCgABAQEAAwEDCQYMAw4FBQUDDgoCAAECAQgAAQUBCwEBCQADBgwLAQEJAAMBCAIIBgwIAg4FBQMOCgICCAMIAgEDAwsBAQgACAIIAwg8U0VMRj5fMRpkZXBvc2l0X2Zvcl9idXJuX3dpdGhfaG9vawhNZXRhZGF0YQ5mdW5naWJsZV9hc3NldAZvYmplY3QRYWRkcmVzc190b19vYmplY3QGT2JqZWN0FnByaW1hcnlfZnVuZ2libGVfc3RvcmUId2l0aGRyYXcNRnVuZ2libGVBc3NldBZ0b2tlbl9tZXNzZW5nZXJfbWludGVyEGRlcG9zaXRfZm9yX2J1cm4LQnVyblJlY2VpcHQHaGFuZGxlcgRidXJuBWVycm9yEGludmFsaWRfYXJndW1lbnT//////////////////////////////////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABxgHT97ibd7VScm1dhMvyptPopzrbvuPwn60WmjKGu1nl0ZxOtuHkLFQ1kB/GFT/Rn2YVZRvg5s7+DwcibUpoRhRjb21waWxhdGlvbl9tZXRhZGF0YQkAAzIuMAMyLjMAAAELHQ4IQQIGAAAAAAAAAAAkBBgLBTgADAkKAAsJCwE4AQwKCwALCgsCCwMLBAsGCwcLCBECEQMCCwABBgEAAAAAAAAAEQQn',
  mainnet:
    'oRzrCwkAAAoIAQAMAgwSAx4qBEgEBUxDB48B4gEI8QKAARDxAx8BAwEEAQcCCgMNAQ8AAgsAAQYHAQABAAkAAAMMAAABBQQFAQgBAQECCAYHAQgBAQEDCwgJAAEBAQQOCQEAAQEBBRAKCgABAQEAAwEDCQYMAw4FBQUDDgoCAAECAQgAAQUBCwEBCQADBgwLAQEJAAMBCAIIBgwIAg4FBQMOCgICCAMIAgEDAwsBAQgACAIIAwg8U0VMRj5fMRpkZXBvc2l0X2Zvcl9idXJuX3dpdGhfaG9vawhNZXRhZGF0YQ5mdW5naWJsZV9hc3NldAZvYmplY3QRYWRkcmVzc190b19vYmplY3QGT2JqZWN0FnByaW1hcnlfZnVuZ2libGVfc3RvcmUId2l0aGRyYXcNRnVuZ2libGVBc3NldBZ0b2tlbl9tZXNzZW5nZXJfbWludGVyEGRlcG9zaXRfZm9yX2J1cm4LQnVyblJlY2VpcHQHaGFuZGxlcgRidXJuBWVycm9yEGludmFsaWRfYXJndW1lbnT//////////////////////////////////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABVR4yeBeTwwvxWA0R5PUXHo0GjD1Fw6WyCuJAv9rZmvgrlj+KoouBXS6HW9haGgHV8tNG8I9bn8+JU8d2gHNa8hRjb21waWxhdGlvbl9tZXRhZGF0YQkAAzIuMAMyLjMAAAELHQ4IQQIGAAAAAAAAAAAkBBgLBTgADAkKAAsJCwE4AQwKCwALCgsCCwMLBAsGCwcLCBECEQMCCwABBgEAAAAAAAAAEQQn',
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
      throw new Error(`Aptos wallet is on "${network.name}" but the app is in ${mode} mode — switch the wallet network and retry`)
    }
  }, [network, mode])

  const switchChain = useCallback(async (_domain: number) => {
    // Aptos has a single network — no EVM-style chain switching needed
  }, [])

  const approveUsdc = useCallback(async (_chainConfig: ChainConfig, _amount: string, _cctpVersion?: number) => {
    // Aptos CCTP: deposit_for_burn handles the coin transfer directly
  }, [])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, destChainType, cctpVersion = 1, transferType }: SourceBurnParams): Promise<string> => {
      if (!connected || !account?.address) {
        throw new Error('Aptos wallet not connected')
      }
      assertWalletNetwork()
      assertDestinationAddress(destAddress, destChainType as ChainType, mode)

      const amountUnits = parseUsdcUnits(amount)
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

        // Aptos → Stellar uses CCTP Forwarder + hook data.
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
    async ({ destDomain: _destDomain, message, attestation, cctpVersion = 1 }: ClaimParams): Promise<string> => {
      if (!connected || !account?.address) {
        throw new Error('Aptos wallet not connected')
      }
      assertWalletNetwork()

      // receive_message is NOT an entry function — it returns a hot-potato
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
