import { useCallback } from 'react'
import freighter from '@stellar/freighter-api'
import { rpc, Contract, TransactionBuilder, Address, nativeToScVal, xdr, Networks, BASE_FEE } from 'stellar-sdk'
import { useNetworkMode } from '../../stores/networkMode'
import { useWalletStore } from '../../stores/walletStore'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig } from '../../types'

// Stellar Soroban RPC endpoints (Horizon doesn't support Soroban calls)
const SOROBAN_RPC: Record<string, Record<string, string>> = {
  mainnet: { '27': 'https://soroban-rpc.stellar.org' },
  testnet: { '27': 'https://soroban-testnet.stellar.org' },
}

const NETWORK_PASSPHRASE: Record<string, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
}

function getSorobanUrl(domain: number, mode: string): string {
  return SOROBAN_RPC[mode]?.[String(domain)] ?? 'https://soroban-rpc.stellar.org'
}

function getNetworkPassphrase(mode: string): string {
  return NETWORK_PASSPHRASE[mode] ?? Networks.PUBLIC
}

/** i128 → ScVal (hi/lo split, big-endian) */
function i128(val: bigint): xdr.ScVal {
  const hi = val >> 64n
  const lo = val & 0xFFFFFFFFFFFFFFFFn
  return nativeToScVal({ hi: Number(hi), lo: Number(lo) }, { type: 'i128' })
}

/** bytes32 hex → ScVal bytes */
function bytes32(hex: string): xdr.ScVal {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const buf = Buffer.from(clean, 'hex')
  return nativeToScVal(buf, { type: 'bytes' })
}

/** Stellar contract address string → ScVal Address */
function contractAddr(contractId: string): xdr.ScVal {
  const addr = new Address(contractId)
  return addr.toScVal()
}

export function useStellarAdapter(): ChainAdapter {
  const mode = useNetworkMode((s) => s.mode)

  const getPublicKey = useCallback(async (): Promise<string> => {
    const store = useWalletStore.getState().stellar
    if (store?.address) return store.address
    const { address } = await freighter.getAddress()
    if (!address) throw new Error('Freighter: no address returned')
    return address
  }, [])

  const buildAndSubmit = useCallback(
    async (chainConfig: ChainConfig, fn: string, args: xdr.ScVal[]): Promise<string> => {
      const publicKey = await getPublicKey()
      const sorobanUrl = getSorobanUrl(chainConfig.domain, mode)
      const passphrase = getNetworkPassphrase(mode)
      const server = new rpc.Server(sorobanUrl, { allowHttp: false })

      // Fetch account & build contract invocation
      const account = await server.getAccount(publicKey)
      const contract = new Contract(chainConfig.token_messenger_v2)
      const op = contract.call(fn, ...args)

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(op)
        .setTimeout(180)
        .build()

      // Simulate to get proper auth & resource footprint
      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed: ${sim.error}`)
      }

      // Prepare (adds auth entries)
      const prepared = await server.prepareTransaction(tx)

      // Sign via Freighter
      const { signedTxXdr, error: signErr } = await freighter.signTransaction(
        prepared.toXDR(),
        { networkPassphrase: passphrase },
      )
      if (signErr) throw new Error(`Freighter sign failed: ${signErr}`)

      // Submit
      const signedTx = TransactionBuilder.fromXDR(signedTxXdr, passphrase) as any
      const sendRes = await server.sendTransaction(signedTx)

      if (sendRes.status === 'ERROR') {
        throw new Error(`Submit failed: ${JSON.stringify(sendRes.errorResult ?? sendRes)}`)
      }

      return sendRes.hash
    },
    [mode, getPublicKey],
  )

  const switchChain = useCallback(async (_domain: number) => {
    // Stellar has a single network, no chain switching
  }, [])

  const approveUsdc = useCallback(async (_chainConfig: ChainConfig, _amount: string, _cctpVersion?: number) => {
    // Stellar CCTP: deposit_for_burn handles the coin transfer directly (no separate approve)
  }, [])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, transferType }: SourceBurnParams): Promise<string> => {
      const amountRaw = BigInt(Math.round(parseFloat(amount) * 1_000_000))
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
            const protocolFee = (amountRaw * BigInt(Math.round(minimumFeeBps * 100))) / 1_000_000n
            maxFee = (protocolFee * 120n) / 100n || BigInt(minimumFeeBps)
          }
        }
      } catch (e) {
        console.warn('[stellar:burnUsdc] Fee fetch failed, using 0:', e)
      }

      // Encode mintRecipient: EVM address zero-padded to 32 bytes, or Stellar contract bytes32
      let mintRecipientScVal: xdr.ScVal
      if (destAddress.startsWith('0x')) {
        mintRecipientScVal = bytes32(destAddress.padStart(64, '0'))
      } else if (destAddress.startsWith('C') && destAddress.length === 56) {
        // Stellar contract address
        mintRecipientScVal = contractAddr(destAddress)
      } else {
        // G... Stellar account address — encode as bytes32 (contract ID derived from account)
        mintRecipientScVal = bytes32(destAddress)
      }

      // deposit_for_burn(amount: i128, destination_domain: u32, mint_recipient: bytes,
      //                   burn_token: address, max_fee: i128, min_finality_threshold: u32)
      const args = [
        i128(amountRaw),
        nativeToScVal(destDomain, { type: 'u32' }),
        mintRecipientScVal,
        contractAddr(chainConfig.usdc_address.split(':')[1] ?? chainConfig.usdc_address),
        i128(maxFee),
        nativeToScVal(minFinalityThreshold, { type: 'u32' }),
      ]

      return buildAndSubmit(chainConfig, 'deposit_for_burn', args)
    },
    [mode, buildAndSubmit],
  )

  const waitForSourceTx = useCallback(
    async (txHash: string, chainConfig: ChainConfig): Promise<any> => {
      const sorobanUrl = getSorobanUrl(chainConfig.domain, mode)
      const server = new rpc.Server(sorobanUrl, { allowHttp: false })
      const deadline = Date.now() + 120_000

      while (Date.now() < deadline) {
        try {
          const res = await server.getTransaction(txHash)
          if (res.status === 'SUCCESS') return res
        } catch {
          // not found yet
        }
        await new Promise((r) => setTimeout(r, 3000))
      }

      throw new Error('Stellar transaction timed out')
    },
    [mode],
  )

  // CctpForwarder addresses — required for Stellar-dest claims
  const CCTP_FORWARDER: Record<string, string> = {
    testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
    mainnet: '', // TODO: add mainnet CctpForwarder address
  }

  const claimOnDest = useCallback(
    async ({ destDomain, message, attestation, destChainType }: ClaimParams): Promise<string> => {
      const publicKey = await getPublicKey()
      const passphrase = getNetworkPassphrase(mode)
      const sorobanUrl = getSorobanUrl(destDomain, mode)
      const server = new rpc.Server(sorobanUrl, { allowHttp: false })

      const account = await server.getAccount(publicKey)

      const args = [bytes32(message), bytes32(attestation)]
      let contractAddress: string
      let fn: string

      if (destChainType === 'stellar') {
        // Stellar destination: MUST use CctpForwarder.mint_and_forward
        const forwarder = CCTP_FORWARDER[mode]
        if (!forwarder) throw new Error('CctpForwarder not configured for this network')
        contractAddress = forwarder
        fn = 'mint_and_forward'
      } else {
        // EVM/other destination: use MessageTransmitter.receive_message
        const { getChainByDomain } = await import('../../config/chains')
        const destChain = getChainByDomain(destDomain, mode as 'mainnet' | 'testnet')
        if (!destChain?.message_transmitter_v2) {
          throw new Error(`No Message Transmitter configured for domain ${destDomain}`)
        }
        contractAddress = destChain.message_transmitter_v2
        fn = 'receive_message'
      }

      const contract = new Contract(contractAddress)

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(contract.call(fn, ...args))
        .setTimeout(180)
        .build()

      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Claim simulation failed: ${sim.error}`)
      }

      const prepared = await server.prepareTransaction(tx)
      const { signedTxXdr, error: signErr } = await freighter.signTransaction(
        prepared.toXDR(),
        { networkPassphrase: passphrase },
      )
      if (signErr) throw new Error(`Freighter sign failed: ${signErr}`)

      const signedTx = TransactionBuilder.fromXDR(signedTxXdr, passphrase) as any
      const sendRes = await server.sendTransaction(signedTx)
      if (sendRes.status === 'ERROR') {
        throw new Error(`Claim submit failed: ${JSON.stringify(sendRes.errorResult ?? sendRes)}`)
      }
      return sendRes.hash
    },
    [mode, getPublicKey],
  )

  return { switchChain, approveUsdc, burnUsdc, waitForSourceTx, claimOnDest }
}
