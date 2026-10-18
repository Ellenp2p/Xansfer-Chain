/** Stellar canary driver: CCTP v2 Soroban deposit_for_burn + CctpForwarder mint. */

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { buildCctpForwarderHookDataBytes, mintRecipientBytes } from '../../src/lib/cctpEncoding'
import { fetchCircleMaxFee } from '../../src/lib/fees'
import { contractsFor, sleep } from './core'
import { STELLAR_CCTP_FORWARDER, bytes32, solanaUsdcAta } from './dest'
import type { BurnRequest, CanaryDriver, ClaimRequest, DriverChain, DriverContext } from './types'

const STELLAR_DECIMALS = 7
const ZERO_BYTES = Buffer.alloc(32)

function server(chain: DriverChain): rpc.Server {
  return new rpc.Server(chain.rpc_url, { allowHttp: false })
}

function keypair(secret: string): Keypair {
  return Keypair.fromSecret(secret)
}

async function submit(
  chain: DriverChain,
  signer: Keypair,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<string> {
  const srv = server(chain)
  const account = await srv.getAccount(signer.publicKey())
  const contract = new Contract(contractId)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(180)
    .build()

  const sim = await srv.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn} simulation failed: ${sim.error}`)
  const prepared = await srv.prepareTransaction(tx)
  prepared.sign(signer)

  const sent = await srv.sendTransaction(prepared)
  if (sent.status === 'ERROR') {
    throw new Error(`${fn} submit failed: ${JSON.stringify(sent.errorResult ?? sent)}`)
  }
  await waitForTransaction(chain, sent.hash)
  return sent.hash
}

async function waitForTransaction(chain: DriverChain, hash: string): Promise<void> {
  const srv = server(chain)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const result = await srv.getTransaction(hash) as { status?: string } | undefined
    if (result?.status === 'SUCCESS') return
    if (result?.status === 'FAILED') throw new Error(`Stellar transaction failed: ${hash}`)
    await sleep(2_000)
  }
  throw new Error(`Stellar transaction timed out: ${hash}`)
}

async function usdcBalanceOf(chain: DriverChain, address: string): Promise<bigint> {
  const srv = server(chain)
  // A funded canary account is required to simulate; use Horizon only for the
  // fallback when no secret/address is available.
  const probe = await srv.getAccount(address)
  const tx = new TransactionBuilder(probe, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(chain.usdc_sac!).call('balance', new Address(address).toScVal()))
    .setTimeout(180)
    .build()
  const sim = await srv.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`balance simulation failed: ${sim.error}`)
  const value = scValToNative(sim.result!.retval)
  return typeof value === 'bigint' ? value : BigInt(String(value))
}

export const stellarDriver: CanaryDriver = {
  type: 'stellar',
  nativeSymbol: 'XLM',
  nativeDecimals: STELLAR_DECIMALS,
  defaultMinNative: 20_000_000n, // 2 XLM (1 XLM reserve + fees)

  address(secret) {
    return keypair(secret).publicKey()
  },

  async nativeBalance(chain, address) {
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404) return 0n
    if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`)
    const data = await res.json() as { balances?: Array<{ asset_type: string; balance: string }> }
    const native = data.balances?.find((b) => b.asset_type === 'native')
    return native ? BigInt(Math.round(Number(native.balance) * 1e7)) : 0n
  },

  async usdcBalance(chain, address) {
    return await usdcBalanceOf(chain, address)
  },

  async burn(ctx: DriverContext, req: BurnRequest): Promise<string> {
    const { chain, version, amountUnits, destDomain, destChain, destAddress, fast, secret } = req
    if (version !== 2) throw new Error('Stellar testnet only supports CCTP v2')
    const { tokenMessenger } = contractsFor(ctx, version, chain.domain)
    if (!chain.usdc_sac) throw new Error('Stellar chain config missing usdc_sac')

    const signer = keypair(secret)
    const srv = server(chain)
    const amountRaw = amountUnits * 10n // Stellar SAC is 7-decimal; CCTP amount is 6-decimal.
    const finalityThreshold = 1000 // testnet only accepts 1000

    const feeUnits = await fetchCircleMaxFee({
      mode: 'testnet',
      srcDomain: chain.domain,
      destDomain,
      finalityThreshold,
      amountUnits,
    })
    const maxFee = feeUnits > 0n ? feeUnits * 10n : 100_000n

    let mintRecipient: xdr.ScVal
    if (destChain.chain_type === 'solana') {
      const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js')
      const ata = new PublicKey(solanaUsdcAta(destAddress, destChain.usdc_address))
      mintRecipient = xdr.ScVal.scvBytes(Buffer.from(ata.toBytes()))
    } else {
      mintRecipient = xdr.ScVal.scvBytes(mintRecipientBytes(bytes32(destAddress)))
    }

    // Approve the TokenMessenger for the exact amount if needed.
    const current = await allowanceOf(chain, signer.publicKey(), tokenMessenger)
    if (current < amountRaw) {
      const latest = await srv.getLatestLedger()
      const expiration = latest.sequence + 100_000
      ctx.log(`${chain.name}: approving ${amountRaw} (7-dec) USDC to ${tokenMessenger}`)
      await submit(chain, signer, chain.usdc_sac, 'approve', [
        new Address(signer.publicKey()).toScVal(),
        new Address(tokenMessenger).toScVal(),
        nativeToScVal(amountRaw, { type: 'i128' }),
        nativeToScVal(expiration, { type: 'u32' }),
      ])
    }

    const args: xdr.ScVal[] = [
      new Address(signer.publicKey()).toScVal(),
      nativeToScVal(amountRaw, { type: 'i128' }),
      nativeToScVal(destDomain, { type: 'u32' }),
      mintRecipient,
      new Address(chain.usdc_sac).toScVal(),
      xdr.ScVal.scvBytes(ZERO_BYTES),
      nativeToScVal(maxFee, { type: 'i128' }),
      nativeToScVal(finalityThreshold, { type: 'u32' }),
    ]

    // Stellar -> Stellar G-addresses would need deposit_for_burn_with_hook; the
    // canary never plans same-domain routes, so the direct call is sufficient.
    ctx.log(`${chain.name} -> ${destChain.name}: burning ${amountRaw} (7-dec) USDC`)
    return await submit(chain, signer, tokenMessenger, 'deposit_for_burn', args)
  },

  async claim(ctx: DriverContext, req: ClaimRequest): Promise<string> {
    const { chain, version, message, attestation, secret } = req
    if (version !== 2) throw new Error('Stellar testnet only supports CCTP v2')
    const signer = keypair(secret)
    const forwarder = STELLAR_CCTP_FORWARDER.testnet
    const args = [xdr.ScVal.scvBytes(Buffer.from(message.slice(2), 'hex')), xdr.ScVal.scvBytes(Buffer.from(attestation.slice(2), 'hex'))]
    ctx.log(`${chain.name}: minting via CctpForwarder ${forwarder}`)
    return await submit(chain, signer, forwarder, 'mint_and_forward', args)
  },

  async waitForBurn(chain, txHash) {
    await waitForTransaction(chain, txHash)
  },
}

async function allowanceOf(chain: DriverChain, owner: string, spender: string): Promise<bigint> {
  const srv = server(chain)
  const account = await srv.getAccount(owner)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      new Contract(chain.usdc_sac!).call(
        'allowance',
        new Address(owner).toScVal(),
        new Address(spender).toScVal(),
      ),
    )
    .setTimeout(180)
    .build()
  const sim = await srv.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) throw new Error(`allowance simulation failed: ${sim.error}`)
  const value = scValToNative(sim.result!.retval)
  return typeof value === 'bigint' ? value : BigInt(String(value))
}
