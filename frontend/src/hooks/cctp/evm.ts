import { useWriteContract, useSwitchChain, useAccount } from 'wagmi'
import { readContract } from 'wagmi/actions'
import { useCallback } from 'react'
import { type Hex, toHex, stringToBytes } from 'viem'
import { ERC20_ABI, TOKEN_MESSENGER_V1_ABI, TOKEN_MESSENGER_V2_ABI, MESSAGE_TRANSMITTER_V1_ABI, MESSAGE_TRANSMITTER_V2_ABI } from '../../config/cctp-abi'
import { getCctpContracts } from '../../config/chains'
import { getChainIdForDomain, isChainSupportedByWagmi } from '../../config/wagmi'
import { useNetworkMode } from '../../stores/networkMode'
import { useWalletState, useWagmiConfig } from '@xansfer/wallet-connect'
import { assertDestinationAddress } from '../../lib/address'
import { parseUsdcUnits, fetchCircleMaxFee } from '../../lib/fees'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig, ChainType } from '../../types'

// Stellar StrKey decoding
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

/** Convert Stellar contract strkey (C...) to bytes32 hex */
function contractStrKeyToBytes32(strkey: string): Hex {
  if (!strkey.startsWith('C') || strkey.length !== 56) {
    throw new Error(`Invalid Stellar contract strkey: ${strkey}`)
  }
  const decoded = stellarStrKeyDecode(strkey)
  // Contract strkey: version(1) + contract_id(32) + checksum(2) = 35 bytes
  const contractId = decoded.slice(1, 33)
  return toHex(contractId, { size: 32 })
}

/**
 * Build hookData for CCTP Forwarder.
 * Layout: [24-byte zero padding][4-byte hook version (0)][4-byte recipient length][recipient UTF-8 bytes]
 */
function buildCctpForwarderHookData(forwardRecipient: string): Hex {
  const recipientBytes = stringToBytes(forwardRecipient)
  const hookData = new Uint8Array(32 + recipientBytes.length)
  // Bytes 24-27: hook version = 0 (already zero)
  // Bytes 28-31: recipient byte length (big-endian uint32)
  hookData[28] = (recipientBytes.length >>> 24) & 0xff
  hookData[29] = (recipientBytes.length >>> 16) & 0xff
  hookData[30] = (recipientBytes.length >>> 8) & 0xff
  hookData[31] = recipientBytes.length & 0xff
  // Bytes 32+: recipient strkey as UTF-8
  hookData.set(recipientBytes, 32)
  return toHex(hookData)
}

// CCTP Forwarder contract addresses on Stellar
const STELLAR_CCTP_FORWARDER: Record<string, string> = {
  testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  mainnet: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
}

export function useEvmAdapter(): ChainAdapter {
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const { chainId: currentChainId } = useAccount()
  const mode = useNetworkMode((s) => s.mode)
  const wagmiConfig = useWagmiConfig()
  const evmAddress = useWalletState().evm?.address ?? null

  const switchChain = useCallback(
    async (domain: number) => {
      const chainId = getChainIdForDomain(domain, mode)
      if (!chainId || !isChainSupportedByWagmi(domain, mode)) {
        throw new Error(`Domain ${domain} is not supported by the wallet connector on ${mode}`)
      }
      if (currentChainId === chainId) return
      await switchChainAsync({ chainId })
    },
    [switchChainAsync, currentChainId, mode],
  )

  const approveUsdc = useCallback(
    async (chainConfig: ChainConfig, amount: string, cctpVersion: number = 2) => {
      const contracts = getCctpContracts(chainConfig.domain, cctpVersion, mode)
      if (!contracts) throw new Error(`CCTP v${cctpVersion} not available for ${chainConfig.name}`)
      if (chainConfig.chain_id == null) throw new Error(`chain_id not configured for ${chainConfig.name}`)
      const amountBigInt = parseUsdcUnits(amount)

      if (!evmAddress) throw new Error('EVM wallet not connected')

      // Check on-chain allowance first — skip approve if already sufficient
      if (!wagmiConfig) throw new Error('wagmi config not ready')
      // The config instance is created by the wallet-connect package at runtime,
      // but TypeScript sees two @wagmi/core copies (workspace vs frontend). The
      // runtime object is the same one readContract accepts, so the cast is safe.
      const allowance = await readContract(wagmiConfig as never, {
        chainId: chainConfig.chain_id as never,
        address: chainConfig.usdc_address as Hex,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [evmAddress as Hex, contracts.tokenMessenger as Hex],
      })

      if (allowance >= amountBigInt) {
        console.log(`[approveUsdc] Already approved ${allowance}, skipping`)
        return
      }

      await writeContractAsync({
        chainId: chainConfig.chain_id,
        address: chainConfig.usdc_address as Hex,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [contracts.tokenMessenger as Hex, amountBigInt],
      })
    },
    [writeContractAsync, mode, wagmiConfig, evmAddress],
  )

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, destChainType, cctpVersion, transferType }: SourceBurnParams): Promise<string> => {
      const contracts = getCctpContracts(chainConfig.domain, cctpVersion, mode)
      if (!contracts) throw new Error(`CCTP v${cctpVersion} not available for ${chainConfig.name}`)
      if (chainConfig.chain_id == null) throw new Error(`chain_id not configured for ${chainConfig.name}`)

      const amountBigInt = parseUsdcUnits(amount)
      const isFast = transferType === 'fast'
      const minFinalityThreshold = isFast ? 1000 : 2000

      if (!destChainType) throw new Error('Destination chain type unknown')
      assertDestinationAddress(destAddress, destChainType as ChainType, mode)

      // Query Circle fee API — throws on network failure instead of burning with maxFee=0
      const maxFee = await fetchCircleMaxFee({
        mode,
        srcDomain: chainConfig.domain,
        destDomain,
        finalityThreshold: minFinalityThreshold,
        amountUnits: amountBigInt,
      })

      // Stellar destination: MUST use depositForBurnWithHook + CCTP Forwarder
      const isStellarDest = destChainType === 'stellar' || destAddress.startsWith('G')

      if (isStellarDest) {
        const forwarderAddr = STELLAR_CCTP_FORWARDER[mode]
        if (!forwarderAddr) throw new Error('Stellar CCTP Forwarder not configured for this network')

        const forwarderBytes32 = contractStrKeyToBytes32(forwarderAddr)
        const hookData = buildCctpForwarderHookData(destAddress)

        return await writeContractAsync({
          chainId: chainConfig.chain_id,
          address: contracts.tokenMessenger as Hex,
          abi: TOKEN_MESSENGER_V2_ABI,
          functionName: 'depositForBurnWithHook',
          args: [
            amountBigInt,
            destDomain,
            forwarderBytes32,      // mintRecipient = CCTP Forwarder
            chainConfig.usdc_address as Hex,
            forwarderBytes32,      // destinationCaller = CCTP Forwarder
            maxFee,
            minFinalityThreshold,
            hookData,              // hookData = forward recipient Stellar address
          ],
        })
      }

      // Standard EVM → non-Stellar transfer. mintRecipient must be bytes32:
      // EVM addresses (20 bytes) are left-padded, Aptos (32 bytes) already fit.
      const cleanAddr = destAddress.replace(/^0x/i, '').toLowerCase()
      if (!/^[0-9a-f]+$/.test(cleanAddr)) {
        throw new Error(`Unsupported destination address format: "${destAddress.slice(0, 8)}…"`)
      }
      const mintRecipient = (`0x${cleanAddr.padStart(64, '0')}`) as Hex
      const destinationCaller = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

      // CCTP v1 depositForBurn(uint256,uint32,bytes32,address) — no destinationCaller/maxFee.
      if (cctpVersion === 1) {
        return await writeContractAsync({
          chainId: chainConfig.chain_id,
          address: contracts.tokenMessenger as Hex,
          abi: TOKEN_MESSENGER_V1_ABI,
          functionName: 'depositForBurn',
          args: [
            amountBigInt,
            destDomain,
            mintRecipient,
            chainConfig.usdc_address as Hex,
          ],
        })
      }

      return await writeContractAsync({
        chainId: chainConfig.chain_id,
        address: contracts.tokenMessenger as Hex,
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: 'depositForBurn',
        args: [
          amountBigInt,
          destDomain,
          mintRecipient,
          chainConfig.usdc_address as Hex,
          destinationCaller,
          maxFee,
          minFinalityThreshold,
        ],
      })
    },
    [writeContractAsync, mode],
  )

  const waitForSourceTx = useCallback(
    async (txHash: string, chainConfig: ChainConfig): Promise<any> => {
      const { createPublicClient, http, defineChain } = await import('viem')
      const { getTransactionReceipt } = await import('viem/actions')

      const chain = defineChain({
        id: chainConfig.chain_id!,
        name: chainConfig.name,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [chainConfig.rpc_url] } },
      })

      const client = createPublicClient({ chain, transport: http(chainConfig.rpc_url) })

      let receipt: any = null
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          receipt = await getTransactionReceipt(client, { hash: txHash as Hex })
          if (receipt) break
        } catch {
          // Not mined yet
        }
        await new Promise((r) => setTimeout(r, 2000))
      }

      if (!receipt) throw new Error('Transaction timed out waiting for confirmation')
      if (receipt.status !== 'success') {
        throw new Error(`Source transaction failed on-chain: ${txHash}`)
      }
      return receipt
    },
    [],
  )

  const claimOnDest = useCallback(
    async ({ destDomain, message, attestation, cctpVersion }: ClaimParams): Promise<string> => {
      const contracts = getCctpContracts(destDomain, cctpVersion, mode)
      if (!contracts) throw new Error(`CCTP v${cctpVersion} not available for dest domain ${destDomain}`)
      const chainId = getChainIdForDomain(destDomain, mode)
      if (chainId == null || !isChainSupportedByWagmi(destDomain, mode)) {
        throw new Error(`Destination domain ${destDomain} is not supported by the wallet connector on ${mode}`)
      }

      const claimTxHash = await writeContractAsync({
        chainId,
        address: contracts.messageTransmitter as Hex,
        abi: cctpVersion === 1 ? MESSAGE_TRANSMITTER_V1_ABI : MESSAGE_TRANSMITTER_V2_ABI,
        functionName: 'receiveMessage',
        args: [message as Hex, attestation as Hex],
      })
      return claimTxHash
    },
    [writeContractAsync, mode],
  )

  return { switchChain, approveUsdc, burnUsdc, waitForSourceTx, claimOnDest }
}
