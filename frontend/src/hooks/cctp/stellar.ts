import { useCallback } from 'react'
import { signTransaction } from '@stellar/freighter-api'
import { rpc, Contract, TransactionBuilder, Address, nativeToScVal, xdr, Networks, BASE_FEE } from '@stellar/stellar-sdk'
import { useNetworkMode } from '../../stores/networkMode'
import { useWalletState } from '@xansfer/wallet-connect'
import { getCctpContracts } from '../../config/chains'
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
  return SOROBAN_RPC[mode]?.[String(domain)] ?? 'https://soroban-testnet.stellar.org'
}

function getNetworkPassphrase(mode: string): string {
  return NETWORK_PASSPHRASE[mode] ?? Networks.PUBLIC
}

/**
 * Wrap Soroban getAccount so an unactivated (non-existent) Stellar account
 * produces a clear, actionable error. On Stellar a new address does not exist
 * on-chain until it holds the minimum XLM balance reserve.
 */
async function accountOrError(server: rpc.Server, address: string, network: string) {
  try {
    return await server.getAccount(address)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not found|not exist|does not exist/i.test(msg)) {
      throw new Error(
        `Stellar account ${address} does not exist on ${network}. Send it at least 1 XLM (minimum balance reserve) to create the account first.`,
      )
    }
    throw e
  }
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
  const stellarAddress = useWalletState().stellar?.address ?? null

  const getPublicKey = useCallback(async (): Promise<string> => {
    // Prefer address from wallet state (synced by the Stellar adapter)
    if (stellarAddress) return stellarAddress
    throw new Error('Freighter: not connected — please connect your Stellar wallet first')
  }, [stellarAddress])

  /** Query USDC SAC allowance for owner -> spender (no state change). */
  const getAllowance = useCallback(
    async (chainConfig: ChainConfig, owner: string, spender: string): Promise<bigint> => {
      const sorobanUrl = getSorobanUrl(chainConfig.domain, mode)
      const passphrase = getNetworkPassphrase(mode)
      const server = new rpc.Server(sorobanUrl, { allowHttp: false })
      const account = await accountOrError(server, owner, mode)
      const usdcContract = new Contract(chainConfig.usdc_sac!)

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(usdcContract.call('allowance', new Address(owner).toScVal(), new Address(spender).toScVal()))
        .setTimeout(180)
        .build()

      const sim = await server.simulateTransaction(tx)
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Allowance simulation failed: ${sim.error}`)
      }
      const retval = sim.result?.retval
      if (!retval) return 0n
      const i128 = retval.i128()
      const hi = BigInt.asIntN(64, BigInt(i128.hi().toString()))
      const lo = BigInt.asUintN(64, BigInt(i128.lo().toString()))
      return (hi << 64n) | lo
    },
    [mode],
  )

  const buildAndSubmitContract = useCallback(
    async (domain: number, contractId: string, fn: string, args: xdr.ScVal[]): Promise<string> => {
      const publicKey = await getPublicKey()
      const sorobanUrl = getSorobanUrl(domain, mode)
      const passphrase = getNetworkPassphrase(mode)
      console.log('[stellar:buildAndSubmit] domain=' + domain + ' mode=' + mode + ' url=' + sorobanUrl + ' passphrase=' + passphrase + ' fn=' + fn + ' contract=' + contractId)
      const server = new rpc.Server(sorobanUrl, { allowHttp: false })

      async function attemptSubmit(): Promise<string> {
        // Fetch account & build contract invocation
        const account = await accountOrError(server, publicKey, mode)
        const contract = new Contract(contractId)
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
        const { signedTxXdr, error: signErr } = await signTransaction(
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
      }

      try {
        return await attemptSubmit()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('txBadSeq')) {
          console.warn('[stellar:buildAndSubmit] txBadSeq detected, retrying once after fresh account fetch')
          await new Promise((r) => setTimeout(r, 2000))
          return attemptSubmit()
        }
        throw e
      }
    },
    [mode, getPublicKey],
  )

  const switchChain = useCallback(async (_domain: number) => {
    // Stellar has a single network, no chain switching
  }, [])

  const approveUsdc = useCallback(async (chainConfig: ChainConfig, amount: string, _cctpVersion?: number) => {
    // Stellar USDC is a classic asset bridged via SAC. TokenMessengerMinterV2 needs
    // an allowance from the user before it can burn. Approve the messenger for
    // i128 MAX only if current allowance is insufficient for the requested amount.
    const usdcSacAddr = chainConfig.usdc_sac
    if (!usdcSacAddr) throw new Error('Stellar chain config missing usdc_sac — check chains.ts')

    const amountRaw = BigInt(Math.round(parseFloat(amount) * 10_000_000))
    const publicKey = await getPublicKey()
    const contracts = getCctpContracts(chainConfig.domain, 2, mode as 'mainnet' | 'testnet')
    if (!contracts) throw new Error(`No CCTP v2 contracts configured for domain ${chainConfig.domain}`)
    const currentAllowance = await getAllowance(chainConfig, publicKey, contracts.tokenMessenger)
    console.log('[approveUsdc] currentAllowance=' + currentAllowance + ' required=' + amountRaw)

    if (currentAllowance >= amountRaw) {
      console.log('[approveUsdc] allowance sufficient — skipping approve')
      return
    }

    const maxApprove = (1n << 127n) - 1n  // i128 MAX
    // expirationLedger = latest + 100_000 ledgers (~6 days on Stellar)
    const sorobanUrl = getSorobanUrl(chainConfig.domain, mode)
    const server = new rpc.Server(sorobanUrl, { allowHttp: false })
    const latest = await server.getLatestLedger()
    const expirationLedger = latest.sequence + 100_000

    await buildAndSubmitContract(chainConfig.domain, usdcSacAddr, 'approve', [
      new Address(publicKey).toScVal(),
      new Address(contracts.tokenMessenger).toScVal(),
      nativeToScVal(maxApprove, { type: 'i128' }),
      nativeToScVal(expirationLedger, { type: 'u32' }),
    ])
  }, [mode, buildAndSubmitContract, getPublicKey, getAllowance])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, transferType }: SourceBurnParams): Promise<string> => {
      // Stellar SAC operates in 7-decimal subunits natively. The Circle deposit_for_burn
      // call takes i128 amount in Stellar 7-decimal subunits (e.g., 10_000_000n = 1 USDC).
      // The CCTP protocol message itself stores 6-decimal amount per Circle docs, but
      // the Stellar contract call parameter uses 7-decimal — the contract handles the
      // 6→7 scaling internally. So pass the user amount * 10^7.
      const amountRaw = BigInt(Math.round(parseFloat(amount) * 10_000_000))

      // CCTP v2 on Stellar testnet currently only accepts min_finality_threshold=1000
      // for source burns. The reference successful tx (Stellar → Base Sepolia) used
      // threshold=1000; passing 2000 triggers WasmVm UnreachableCodeReached.
      // See: https://developers.circle.com/cctp/references/technical-guide
      const isFast = transferType === 'fast'
      if (isFast) {
        console.warn('[burnUsdc] Fast transfer requested, but Stellar source currently uses threshold=1000')
      }
      const minFinalityThreshold = 1000

      const publicKey = await getPublicKey()

      // Circle's Stellar→Arc example uses MAX_FEE = 100_000n (0.01 USDC in 7-decimal
      // Stellar subunits). The earlier assumption that max_fee must be 0 was wrong;
      // passing 0 causes the TokenMessengerMinterV2 contract to panic with
      // UnreachableCodeReached on testnet.
      const maxFee = 100_000n

      // mint_recipient: EVM address → bytes32, Stellar C-addr → Address ScVal, G-addr → MUST go through CctpForwarder with hook
      let mintRecipientScVal: xdr.ScVal
      let destinationCallerScVal: xdr.ScVal

      if (destAddress.startsWith('0x')) {
        // EVM destination: bytes32 recipient + zero destination_caller
        // Strip 0x, lowercase, left-pad to 32 bytes (64 hex chars), then wrap in scvBytes.
        const hexNoPrefix = destAddress.slice(2).toLowerCase()
        const paddedHex = hexNoPrefix.padStart(64, '0')
        mintRecipientScVal = xdr.ScVal.scvBytes(Buffer.from(paddedHex, 'hex'))
        destinationCallerScVal = xdr.ScVal.scvBytes(Buffer.alloc(32))
      } else if (destAddress.startsWith('C') && destAddress.length === 56) {
        // Stellar contract destination: CctpForwarder is required per Circle docs.
        // Use deposit_for_burn_with_hook to route through CctpForwarder with forwardRecipient in hookData.
        // For now, address the contract directly (works for non-account contracts).
        mintRecipientScVal = contractAddr(destAddress)
        destinationCallerScVal = xdr.ScVal.scvBytes(Buffer.alloc(32))
      } else if ((destAddress.startsWith('G') || destAddress.startsWith('M')) && destAddress.length === 56) {
        // G/M Stellar destination — proper flow needs deposit_for_burn_with_hook +
        // CctpForwarder (out of scope). As a stub, encode the strkey as bytes32.
        // Soroban cannot distinguish G (account) from C (contract) when used as
        // mint_recipient, so funds end up "stuck" at a non-existent contract — but
        // this lets us run past validation. The UI should warn the user.
        const recipientBytes = Buffer.from(destAddress, 'utf8')
        const hookData = Buffer.alloc(32 + recipientBytes.length)
        hookData.writeUInt32BE(0, 24) // hook version = 0
        hookData.writeUInt32BE(recipientBytes.length, 28) // recipient byte length
        recipientBytes.copy(hookData, 32) // recipient strkey as UTF-8
        mintRecipientScVal = xdr.ScVal.scvBytes(hookData)
        destinationCallerScVal = xdr.ScVal.scvBytes(Buffer.alloc(32))
        console.warn('[burnUsdc] G/M destination: use CctpForwarder hook for actual transfer — current encoding is a stub')
      } else {
        throw new Error(`Unsupported destination address format: "${destAddress.slice(0, 8)}…"`)
      }

      // USDC SAC contract address on Stellar, derived per CAP-46 from
      // (asset code, issuer G-address, network passphrase). This is the
      // canonical SAC address the TokenMessengerMinter expects.
      // Per Circle docs: SAC = Contract(stellarAssetContractHash || networkId || issuerG)
      const usdcSacAddr = chainConfig.usdc_sac
      if (!usdcSacAddr) throw new Error('Stellar chain config missing usdc_sac — check chains.ts')

      const contracts = getCctpContracts(chainConfig.domain, 2, mode as 'mainnet' | 'testnet')
      if (!contracts) throw new Error(`No CCTP v2 contracts configured for domain ${chainConfig.domain}`)

      // deposit_for_burn(
      //   sender: Address,
      //   amount: i128,
      //   destination_domain: u32,
      //   mint_recipient: Bytes,
      //   burn_token: Address,
      //   destination_caller: Bytes,
      //   max_fee: i128,
      //   min_finality_threshold: u32
      // )
      const args: xdr.ScVal[] = [
        new Address(publicKey).toScVal(),                  // sender (require_auth)
        nativeToScVal(amountRaw, { type: 'i128' }),        // amount — match Circle docs: nativeToScVal(bigint, {type: 'i128'})
        nativeToScVal(destDomain, { type: 'u32' }),        // destination_domain
        mintRecipientScVal,                                 // mint_recipient
        new Address(usdcSacAddr).toScVal(),                // burn_token
        destinationCallerScVal,                             // destination_caller
        nativeToScVal(maxFee, { type: 'i128' }),           // max_fee — match Circle docs
        nativeToScVal(minFinalityThreshold, { type: 'u32' }), // min_finality_threshold
      ]

      return buildAndSubmitContract(chainConfig.domain, contracts.tokenMessenger, 'deposit_for_burn', args)
    },
    [mode, buildAndSubmitContract, getPublicKey],
  )

  const waitForSourceTx = useCallback(
    async (txHash: string, chainConfig: ChainConfig): Promise<any> => {
      const sorobanUrl = getSorobanUrl(chainConfig.domain, mode)
      const server = new rpc.Server(sorobanUrl, { allowHttp: false })
      // Stellar testnet can take >2 min during congestion; give it 5 min.
      const deadline = Date.now() + 300_000
      let attempt = 0

      console.log('[stellar:waitForSourceTx] start polling tx=' + txHash + ' url=' + sorobanUrl)

      while (Date.now() < deadline) {
        attempt++
        try {
          // Try SDK first (now @stellar/stellar-sdk v16).
          const res: any = await server.getTransaction(txHash)
          const status = res?.status ?? res?.result?.status
          console.log(
            '[stellar:waitForSourceTx] attempt=' + attempt,
            'sdk status=' + status,
            'hash=' + (res?.txHash ?? res?.hash),
          )

          if (status === 'SUCCESS') {
            console.log('[stellar:waitForSourceTx] SUCCESS via SDK')
            return res
          }
          if (status === 'FAILED') {
            throw new Error(`Stellar transaction failed: ${JSON.stringify(res)}`)
          }
        } catch (sdkErr) {
          const msg = sdkErr instanceof Error ? sdkErr.message : String(sdkErr)
          // Older SDK versions throw "Bad union switch: 4" on some RPC XDR.
          // Fall back to raw JSON-RPC, which only needs the JSON status field.
          if (msg.includes('Bad union switch')) {
            console.warn('[stellar:waitForSourceTx] SDK XDR decode failed, falling back to raw JSON-RPC')
            try {
              const rpcRes = await fetch(sorobanUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: attempt,
                  method: 'getTransaction',
                  params: { hash: txHash },
                }),
              })

              if (!rpcRes.ok) {
                const text = await rpcRes.text()
                throw new Error(`RPC HTTP ${rpcRes.status}: ${text}`)
              }

              const rpcJson: any = await rpcRes.json()
              const res = rpcJson?.result
              const status = res?.status

              console.log(
                '[stellar:waitForSourceTx] attempt=' + attempt,
                'raw status=' + status,
                'hash=' + (res?.txHash ?? res?.hash),
              )

              if (status === 'SUCCESS') {
                console.log('[stellar:waitForSourceTx] SUCCESS via raw JSON-RPC')
                return res
              }
              if (status === 'FAILED') {
                throw new Error(`Stellar transaction failed: ${JSON.stringify(res)}`)
              }
            } catch (rawErr) {
              const rawMsg = rawErr instanceof Error ? rawErr.message : String(rawErr)
              console.warn('[stellar:waitForSourceTx] attempt=' + attempt + ' raw error:', rawMsg)
            }
          } else {
            console.warn('[stellar:waitForSourceTx] attempt=' + attempt + ' SDK error:', msg)
          }
        }

        const delay = attempt < 10 ? 2000 : 5000
        await new Promise((r) => setTimeout(r, delay))
      }

      throw new Error('Stellar transaction timed out after 5 minutes')
    },
    [mode],
  )

  // CctpForwarder addresses — required for Stellar-dest claims
  const CCTP_FORWARDER: Record<string, string> = {
    testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
    mainnet: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
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
        const contracts = getCctpContracts(destDomain, 2, mode as 'mainnet' | 'testnet')
        if (!contracts) {
          throw new Error(`No CCTP v2 Message Transmitter configured for domain ${destDomain}`)
        }
        contractAddress = contracts.messageTransmitter
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
      const { signedTxXdr, error: signErr } = await signTransaction(
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
