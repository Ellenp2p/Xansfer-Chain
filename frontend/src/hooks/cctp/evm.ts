import { useWriteContract, useSwitchChain, useAccount } from 'wagmi'
import { readContract } from 'wagmi/actions'
import { useCallback } from 'react'
import { parseUnits, type Hex, toHex, stringToBytes } from 'viem'
import { ERC20_ABI, TOKEN_MESSENGER_V2_ABI, MESSAGE_TRANSMITTER_V2_ABI } from '../../config/cctp-abi'
import { getCctpContracts } from '../../config/cctp'
import { getChainIdForDomain, isChainSupportedByWagmi, mainnetConfig, testnetConfig } from '../../config/wagmi'
import { useNetworkMode } from '../../stores/networkMode'
import { useWalletStore } from '../../stores/walletStore'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig } from '../../types'

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
  // mainnet: TODO — add when available
}

export function useEvmAdapter(): ChainAdapter {
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const { chainId: currentChainId } = useAccount()
  const mode = useNetworkMode((s) => s.mode)

  const switchChain = useCallback(
    async (domain: number) => {
      const chainId = getChainIdForDomain(domain, mode)
      if (!chainId || !isChainSupportedByWagmi(domain, mode)) return
      if (currentChainId === chainId) return
      await switchChainAsync({ chainId })
    },
    [switchChainAsync, currentChainId, mode],
  )

  const approveUsdc = useCallback(
    async (chainConfig: ChainConfig, amount: string, cctpVersion: number = 2) => {
      const contracts = getCctpContracts(chainConfig.domain, cctpVersion, mode)
      if (!contracts) throw new Error(`CCTP v${cctpVersion} not available for ${chainConfig.name}`)
      const amountBigInt = parseUnits(amount, 6)

      const wallet = useWalletStore.getState().evm
      if (!wallet?.address) throw new Error('EVM wallet not connected')

      // Check on-chain allowance first — skip approve if already sufficient
      const wagmiConfig = mode === 'testnet' ? testnetConfig : mainnetConfig
      const allowance = await readContract(wagmiConfig, {
        address: chainConfig.usdc_address as Hex,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [wallet.address as Hex, contracts.tokenMessenger as Hex],
      })

      if (allowance >= amountBigInt) {
        console.log(`[approveUsdc] Already approved ${allowance}, skipping`)
        return
      }

      await writeContractAsync({
        address: chainConfig.usdc_address as Hex,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [contracts.tokenMessenger as Hex, amountBigInt],
      })
    },
    [writeContractAsync, mode],
  )

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, destChainType, cctpVersion, transferType }: SourceBurnParams): Promise<string> => {
      const contracts = getCctpContracts(chainConfig.domain, cctpVersion, mode)
      if (!contracts) throw new Error(`CCTP v${cctpVersion} not available for ${chainConfig.name}`)

      const amountBigInt = parseUnits(amount, 6)
      const isFast = transferType === 'fast'
      const minFinalityThreshold = isFast ? 1000 : 2000

      // Query Circle fee API
      let maxFee = 0n
      try {
        const feeBase = mode === 'testnet'
          ? 'https://iris-api-sandbox.circle.com'
          : 'https://iris-api.circle.com'
        const feeUrl = `${feeBase}/v2/burn/USDC/fees/${chainConfig.domain}/${destDomain}`
        const feeResp = await fetch(feeUrl)
        if (feeResp.ok) {
          const feeData = await feeResp.json()
          const feeEntry = feeData.find((f: any) => f.finalityThreshold === minFinalityThreshold)
          if (feeEntry && feeEntry.minimumFee > 0) {
            const minimumFeeBps = feeEntry.minimumFee
            const protocolFee = (amountBigInt * BigInt(Math.round(minimumFeeBps * 100))) / 1_000_000n
            const bufferedFee = (protocolFee * 120n) / 100n
            maxFee = bufferedFee > 0n ? bufferedFee : BigInt(minimumFeeBps)
          }
        }
      } catch (e) {
        console.warn('[burnUsdc] Failed to fetch fee, using 0:', e)
      }

      // Stellar destination: MUST use depositForBurnWithHook + CCTP Forwarder
      const isStellarDest = destChainType === 'stellar' || destAddress.startsWith('G')

      if (isStellarDest) {
        const forwarderAddr = STELLAR_CCTP_FORWARDER[mode]
        if (!forwarderAddr) throw new Error('Stellar CCTP Forwarder not configured for this network')

        const forwarderBytes32 = contractStrKeyToBytes32(forwarderAddr)
        const hookData = buildCctpForwarderHookData(destAddress)

        return await writeContractAsync({
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

      // Standard EVM → EVM transfer
      const zeroPad = '000000000000000000000000'
      const mintRecipient = (`0x${zeroPad}${destAddress.slice(2).toLowerCase()}`) as Hex
      const destinationCaller = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

      return await writeContractAsync({
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
      return receipt
    },
    [],
  )

  const claimOnDest = useCallback(
    async ({ destDomain, message, attestation, cctpVersion }: ClaimParams): Promise<string> => {
      const contracts = getCctpContracts(destDomain, cctpVersion, mode)
      if (!contracts) throw new Error(`CCTP v${cctpVersion} not available for dest domain ${destDomain}`)

      const claimTxHash = await writeContractAsync({
        address: contracts.messageTransmitter as Hex,
        abi: MESSAGE_TRANSMITTER_V2_ABI,
        functionName: 'receiveMessage',
        args: [message as Hex, attestation as Hex],
      })
      return claimTxHash
    },
    [writeContractAsync, mode],
  )

  return { switchChain, approveUsdc, burnUsdc, waitForSourceTx, claimOnDest }
}
