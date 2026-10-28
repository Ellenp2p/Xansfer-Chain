/**
 * Sui canary driver: CCTP v1 and v2 on testnet.
 *
 * The public Sui fullnode JSON-RPC was retired, so this driver talks to the
 * GraphQL endpoint (same one the frontend uses) and signs with an Ed25519 key.
 */

import { SuiGraphQLClient } from '@mysten/sui/graphql'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import {
  buildSuiV2BurnTransaction,
  buildSuiV2ClaimTransaction,
  type SuiV2Deployment,
} from '../../src/lib/suiCctpV2'
import { normalizeMintRecipient } from '../../src/lib/cctpEncoding'
import { contractsFor } from './core'
import type { BurnRequest, CanaryDriver, ClaimRequest, DriverChain, DriverContext } from './types'

const GRAPHQL_ENDPOINT: Record<string, string> = {
  testnet: 'https://graphql.testnet.sui.io/graphql',
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
}

const DENY_LIST_OBJECT_ID = '0x0000000000000000000000000000000000000000000000000000000000000403'
const SUI_NATIVE = '0x2::sui::SUI'

const CCTP_OBJECTS: Record<string, { tokenMessengerMinterState: string; messageTransmitterState: string; treasury: string }> = {
  mainnet: {
    tokenMessengerMinterState: '0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f',
    messageTransmitterState: '0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af',
    treasury: '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
  },
  testnet: {
    tokenMessengerMinterState: '0x5252abd1137094ed1db3e0d75bc36abcd287aee4bc310f8e047727ef5682e7c2',
    messageTransmitterState: '0x98234bd0fa9ac12cc0a20a144a22e36d6a32f7e0a97baaeaf9c76cdc6d122d2e',
    treasury: '0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe',
  },
}

const CCTP_V2_OBJECTS: Record<string, {
  tokenMessengerMinterState: string
  messageTransmitterState: string
  stablecoinHandlerState: string
  stablecoinHandlerPackage: string
  treasury: string
}> = {
  mainnet: {
    tokenMessengerMinterState: '0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167',
    messageTransmitterState: '0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c',
    stablecoinHandlerState: '0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41',
    stablecoinHandlerPackage: '0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf',
    treasury: '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
  },
  testnet: {
    tokenMessengerMinterState: '0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0',
    messageTransmitterState: '0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed',
    stablecoinHandlerState: '0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32',
    stablecoinHandlerPackage: '0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561',
    treasury: '0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe',
  },
}

function client(chain: DriverChain): SuiGraphQLClient {
  return new SuiGraphQLClient({ url: GRAPHQL_ENDPOINT.testnet, network: 'testnet' })
}

function keypairFromSecret(secret: string): Ed25519Keypair {
  const decoded = decodeSuiPrivateKey(secret)
  if (decoded.scheme !== 'ED25519') {
    throw new Error(`Sui canary only supports ED25519 keys (got ${decoded.scheme})`)
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey)
}

function usdcCoinType(chain: DriverChain): string {
  const pkg = chain.usdc_address.split('::')[0]
  return `${pkg}::usdc::USDC`
}

async function signAndWait(
  chain: DriverChain,
  signer: Ed25519Keypair,
  transaction: Transaction,
): Promise<string> {
  const sui = client(chain)
  const result = await sui.signAndExecuteTransaction({ transaction, signer, include: { effects: true } })
  const tx = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction
  if (!tx.status.success) {
    throw new Error(`Sui transaction failed: ${JSON.stringify(tx.status.error ?? tx.status)}`)
  }
  await sui.waitForTransaction({ digest: tx.digest })
  return tx.digest
}

async function findCoin(chain: DriverChain, owner: string, coinType: string, required: bigint): Promise<string> {
  const coins = await client(chain).listCoins({ owner, coinType, limit: 50 })
  const match = coins.objects
    .filter((coin) => BigInt(coin.balance) >= required)
    .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))[0]
  if (!match) throw new Error(`Sui: no ${coinType} coin with >= ${required} units`)
  return match.objectId
}

export const suiDriver: CanaryDriver = {
  type: 'sui',
  nativeSymbol: 'SUI',
  nativeDecimals: 9,
  defaultMinNative: 100_000_000n, // 0.1 SUI

  address(secret) {
    return keypairFromSecret(secret).toSuiAddress()
  },

  async nativeBalance(chain, address) {
    const res = await client(chain).getBalance({ owner: address, coinType: SUI_NATIVE })
    return BigInt(res.balance.balance)
  },

  async usdcBalance(chain, address) {
    const res = await client(chain).getBalance({ owner: address, coinType: usdcCoinType(chain) })
    return BigInt(res.balance.balance)
  },

  async burn(ctx: DriverContext, req: BurnRequest): Promise<string> {
    const { chain, version, amountUnits, destDomain, destAddress, secret } = req
    if (version !== 1 && version !== 2) throw new Error(`Unsupported Sui CCTP version: v${version}`)
    const { tokenMessenger, messageTransmitter } = contractsFor(ctx, version, chain.domain)
    const signer = keypairFromSecret(secret)
    const owner = signer.toSuiAddress()
    const coinType = usdcCoinType(chain)

    let tx: Transaction
    if (version === 2) {
      const objects = CCTP_V2_OBJECTS.testnet
      const deployment: SuiV2Deployment = {
        tokenMessenger,
        messageTransmitter,
        stablecoinHandler:
          ctx.config.v2.stablecoin_handler?.[String(chain.domain)] ?? objects.stablecoinHandlerPackage,
        tokenMessengerState: objects.tokenMessengerMinterState,
        messageTransmitterState: objects.messageTransmitterState,
        stablecoinHandlerState: objects.stablecoinHandlerState,
        treasury: objects.treasury,
      }

      let coinObjectId: string | null = null
      try {
        coinObjectId = await findCoin(chain, owner, coinType, amountUnits)
      } catch {
        // USDC may be held as a SIP-58 address balance instead of a Coin object.
        coinObjectId = null
      }

      tx = buildSuiV2BurnTransaction({
        sender: owner,
        deployment,
        usdcCoinType: coinType,
        amount: amountUnits,
        destinationDomain: destDomain,
        mintRecipient: normalizeMintRecipient(destAddress),
        coinObjectId,
      })
    } else {
      const objects = CCTP_OBJECTS.testnet
      const coinId = await findCoin(chain, owner, coinType, amountUnits)
      tx = new Transaction()
      tx.setSender(owner)
      const [split] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(amountUnits)])
      tx.moveCall({
        target: `${tokenMessenger}::deposit_for_burn::deposit_for_burn`,
        typeArguments: [coinType],
        arguments: [
          split,
          tx.pure.u32(destDomain),
          tx.pure.address(normalizeMintRecipient(destAddress)),
          tx.object(objects.tokenMessengerMinterState),
          tx.object(objects.messageTransmitterState),
          tx.object(DENY_LIST_OBJECT_ID),
          tx.object(objects.treasury),
        ],
      })
    }

    ctx.log(`${chain.name}: burning ${amountUnits} USDC units (v${version}) -> domain ${destDomain}`)
    return await signAndWait(chain, signer, tx)
  },

  async claim(ctx: DriverContext, req: ClaimRequest): Promise<string> {
    const { chain, version, message, attestation, secret } = req
    if (version !== 1 && version !== 2) throw new Error(`Unsupported Sui CCTP version: v${version}`)
    const { tokenMessenger, messageTransmitter } = contractsFor(ctx, version, chain.domain)
    const signer = keypairFromSecret(secret)
    const coinType = usdcCoinType(chain)

    const messageBytes = Array.from(Buffer.from(message.slice(2), 'hex'))
    const attestationBytes = Array.from(Buffer.from(attestation.slice(2), 'hex'))

    let tx: Transaction
    if (version === 2) {
      const objects = CCTP_V2_OBJECTS.testnet
      const deployment: SuiV2Deployment = {
        tokenMessenger,
        messageTransmitter,
        stablecoinHandler:
          ctx.config.v2.stablecoin_handler?.[String(chain.domain)] ?? objects.stablecoinHandlerPackage,
        tokenMessengerState: objects.tokenMessengerMinterState,
        messageTransmitterState: objects.messageTransmitterState,
        stablecoinHandlerState: objects.stablecoinHandlerState,
        treasury: objects.treasury,
      }
      tx = buildSuiV2ClaimTransaction({
        sender: signer.toSuiAddress(),
        deployment,
        usdcCoinType: coinType,
        message,
        attestation,
      })
    } else {
      const objects = CCTP_OBJECTS.testnet
      tx = new Transaction()
      tx.setSender(signer.toSuiAddress())
      const receipt = tx.moveCall({
        target: `${messageTransmitter}::receive_message::receive_message`,
        arguments: [
          tx.pure.vector('u8', messageBytes),
          tx.pure.vector('u8', attestationBytes),
          tx.object(objects.messageTransmitterState),
        ],
      })
      const stamped = tx.moveCall({
        target: `${tokenMessenger}::handle_receive_message::handle_receive_message`,
        typeArguments: [coinType],
        arguments: [
          receipt,
          tx.object(objects.tokenMessengerMinterState),
          tx.object(DENY_LIST_OBJECT_ID),
          tx.object(objects.treasury),
        ],
      })
      const [stampTicket] = tx.moveCall({
        target: `${tokenMessenger}::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message`,
        arguments: [stamped],
      })
      const authenticatorType = `${tokenMessenger}::message_transmitter_authenticator::MessageTransmitterAuthenticator`
      const stampedReceipt = tx.moveCall({
        target: `${messageTransmitter}::receive_message::stamp_receipt`,
        typeArguments: [authenticatorType],
        arguments: [stampTicket, tx.object(objects.messageTransmitterState)],
      })
      tx.moveCall({
        target: `${messageTransmitter}::receive_message::complete_receive_message`,
        arguments: [stampedReceipt, tx.object(objects.messageTransmitterState)],
      })
    }

    ctx.log(`${chain.name}: claiming CCTP v${version} message`)
    return await signAndWait(chain, signer, tx)
  },
}
