/** Aptos canary driver: CCTP v2 (testnet) burn/claim via Circle's Move scripts. */

import { Account, AccountAddress, Aptos, AptosConfig, Ed25519PrivateKey, MoveVector, Network, U32, U64 } from '@aptos-labs/ts-sdk'
import {
  BURN_SCRIPT_BYTECODE,
  BURN_SCRIPT_BYTECODE_V2,
  BURN_SCRIPT_BYTECODE_V2_WITH_HOOK,
  RECEIVE_SCRIPT_BYTECODE,
  RECEIVE_SCRIPT_BYTECODE_V2,
} from '../../src/config/aptosScripts'
import { buildCctpForwarderHookData, contractStrKeyToBytes32 } from '../../src/lib/cctpEncoding'
import { fetchCircleMaxFee } from '../../src/lib/fees'
import { contractsFor } from './core'
import { STELLAR_CCTP_FORWARDER, isStellarAccount, solanaUsdcAtaHex } from './dest'
import type { BurnRequest, CanaryDriver, ClaimRequest, DriverChain, DriverContext } from './types'

const ZERO_ADDRESS = `0x${'0'.repeat(64)}`
const APTOS_DECIMALS = 8

function client(chain: DriverChain): Aptos {
  return new Aptos(new AptosConfig({ network: Network.TESTNET, fullnode: chain.rpc_url }))
}

function accountFromSecret(secret: string): Account {
  const clean = secret.replace(/^ed25519-priv-/, '')
  return Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(clean) })
}

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex.slice(0, 12)}…`)
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16))
  return bytes
}

function script(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

async function submit(
  aptos: Aptos,
  account: Account,
  bytecode: string,
  functionArguments: unknown[],
): Promise<string> {
  const transaction = await aptos.transaction.build.simple({
    sender: account.accountAddress,
    data: { bytecode: script(bytecode), functionArguments: functionArguments as never[] },
  })
  const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction })
  const committed = await aptos.waitForTransaction({ transactionHash: pending.hash })
  if (!committed.success) {
    throw new Error(`Aptos transaction failed: ${committed.vm_status ?? 'unknown VM status'}`)
  }
  return pending.hash
}

export const aptosDriver: CanaryDriver = {
  type: 'aptos',
  nativeSymbol: 'APT',
  nativeDecimals: APTOS_DECIMALS,
  defaultMinNative: 20_000_000n, // 0.2 APT

  address(secret) {
    return accountFromSecret(secret).accountAddress.toStringLong()
  },

  async nativeBalance(chain, address) {
    return BigInt(await client(chain).getAccountAPTAmount({ accountAddress: address }))
  },

  async usdcBalance(chain, address) {
    const result = await client(chain).view({
      payload: {
        function: '0x1::primary_fungible_store::balance',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [address, chain.usdc_address],
      },
    })
    return BigInt(String(result[0] ?? '0'))
  },

  async burn(ctx: DriverContext, req: BurnRequest): Promise<string> {
    const { chain, version, amountUnits, destDomain, destChain, destAddress, fast, secret } = req
    const aptos = client(chain)
    const account = accountFromSecret(secret)
    const usdc = AccountAddress.from(chain.usdc_address)

    const stellarAccount = destChain.chain_type === 'stellar' && isStellarAccount(destAddress)
    let mintRecipient: AccountAddress
    let hookData = ''
    if (stellarAccount) {
      mintRecipient = AccountAddress.from(contractStrKeyToBytes32(STELLAR_CCTP_FORWARDER.testnet))
      hookData = buildCctpForwarderHookData(destAddress)
    } else if (destChain.chain_type === 'solana') {
      mintRecipient = AccountAddress.from(solanaUsdcAtaHex(destAddress, destChain.usdc_address))
    } else {
      mintRecipient = AccountAddress.from(destAddress)
    }

    if (version === 1) {
      if (hookData) throw new Error('CCTP v1 has no hook path; Stellar destinations require v2')
      const bytecode = BURN_SCRIPT_BYTECODE.testnet
      return await submit(aptos, account, bytecode, [
        new U64(amountUnits),
        new U32(destDomain),
        mintRecipient,
        usdc,
      ])
    }

    const finalityThreshold = fast ? 1000 : 2000
    const maxFee = await fetchCircleMaxFee({
      mode: 'testnet',
      srcDomain: chain.domain,
      destDomain,
      finalityThreshold,
      amountUnits,
    })

    if (stellarAccount) {
      const forwarder = AccountAddress.from(contractStrKeyToBytes32(STELLAR_CCTP_FORWARDER.testnet))
      return await submit(aptos, account, BURN_SCRIPT_BYTECODE_V2_WITH_HOOK.testnet, [
        new U64(amountUnits),
        new U32(destDomain),
        forwarder,
        forwarder,
        usdc,
        new U64(maxFee),
        new U32(finalityThreshold),
        MoveVector.U8(hexToBytes(hookData)),
      ])
    }

    return await submit(aptos, account, BURN_SCRIPT_BYTECODE_V2.testnet, [
      new U64(amountUnits),
      new U32(destDomain),
      mintRecipient,
      AccountAddress.from(ZERO_ADDRESS),
      usdc,
      new U64(maxFee),
      new U32(finalityThreshold),
    ])
  },

  async claim(ctx: DriverContext, req: ClaimRequest): Promise<string> {
    const { chain, version, message, attestation, secret } = req
    const aptos = client(chain)
    const account = accountFromSecret(secret)
    const bytecode = version === 1 ? RECEIVE_SCRIPT_BYTECODE.testnet : RECEIVE_SCRIPT_BYTECODE_V2.testnet
    return await submit(aptos, account, bytecode, [
      MoveVector.U8(hexToBytes(message)),
      MoveVector.U8(hexToBytes(attestation)),
    ])
  },
}
