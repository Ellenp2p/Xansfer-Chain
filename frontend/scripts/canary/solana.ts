/**
 * Solana canary driver: CCTP v2 (devnet).
 *
 * The public Solana fullnode still serves JSON-RPC, so this driver builds the
 * Anchor instructions by hand (discriminators + Borsh args + PDA seeds taken
 * from Circle's solana-cctp-contracts) and signs with @solana/web3.js. Keeping
 * the encoder local avoids pulling Anchor's runtime into the repo.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { fetchCircleMaxFee } from '../../src/lib/fees'
import { STELLAR_CCTP_FORWARDER, buildHookDataForStellar } from './dest'
import type { BurnRequest, CanaryDriver, ClaimRequest, DriverChain, DriverContext } from './types'

const TOKEN_MESSENGER_MINTER = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe')
const MESSAGE_TRANSMITTER = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

const DEPOSIT_DISCRIMINATOR = Buffer.from([215, 60, 61, 46, 114, 55, 128, 176])
const DEPOSIT_HOOK_DISCRIMINATOR = Buffer.from([111, 245, 62, 131, 204, 108, 223, 155])
const RECEIVE_DISCRIMINATOR = Buffer.from([38, 144, 127, 225, 31, 225, 238, 25])

const EMPTY_PUBKEY = PublicKey.default

function connection(chain: DriverChain): Connection {
  return new Connection(chain.rpc_url, { commitment: 'confirmed' })
}

function pda(seeds: Array<Buffer | Uint8Array>, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0]
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(value)
  return out
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

function keypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim()
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]))
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed))
}

export function usdcAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)
}

function ensureAtaInstruction(owner: PublicKey, mint: PublicKey, ata: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  })
}

function readMintRecipient(hex: string): PublicKey {
  const clean = hex.replace(/^0x/i, '').padStart(64, '0')
  return new PublicKey(Buffer.from(clean, 'hex'))
}

function encodeVec(bytes: Uint8Array): Buffer {
  return Buffer.concat([u32(bytes.length), Buffer.from(bytes)])
}

function parseMessage(message: string): {
  sourceDomain: number
  nonce: Buffer
  burnToken: Buffer
} {
  const data = Buffer.from(message.replace(/^0x/, ''), 'hex')
  if (data.length < 148 + 36) throw new Error('CCTP message is too short to parse')
  return {
    sourceDomain: data.readUInt32BE(4),
    nonce: data.subarray(12, 44),
    burnToken: data.subarray(148 + 4, 148 + 36),
  }
}

/** TokenMessenger state layout: denylister(32) owner(32) pendingOwner(32) bodyVersion(4) bump(1) feeRecipient(32)… */
const FEE_RECIPIENT_OFFSET = 8 + 32 + 32 + 32 + 4 + 1

async function readFeeRecipient(chain: DriverChain): Promise<PublicKey> {
  const tmState = pda([Buffer.from('token_messenger')], TOKEN_MESSENGER_MINTER)
  const info = await connection(chain).getAccountInfo(tmState)
  if (!info) throw new Error('Solana TokenMessenger state account not found')
  const data = info.data
  if (data.length < FEE_RECIPIENT_OFFSET + 32) throw new Error('Unexpected TokenMessenger account layout')
  return new PublicKey(data.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32))
}

function depositInstruction(opts: {
  amount: bigint
  owner: PublicKey
  eventRentPayer: PublicKey
  burnTokenAccount: PublicKey
  destDomain: number
  mintRecipient: PublicKey
  destinationCaller: PublicKey
  maxFee: bigint
  finalityThreshold: number
  hookData?: Uint8Array
  messageSentEventData: PublicKey
  usdcMint: PublicKey
}): TransactionInstruction {
  const {
    amount,
    owner,
    eventRentPayer,
    burnTokenAccount,
    destDomain,
    mintRecipient,
    destinationCaller,
    maxFee,
    finalityThreshold,
    hookData,
    messageSentEventData,
    usdcMint,
  } = opts

  const data = hookData
    ? Buffer.concat([
        DEPOSIT_HOOK_DISCRIMINATOR,
        u64(amount),
        u32(destDomain),
        mintRecipient.toBuffer(),
        destinationCaller.toBuffer(),
        u64(maxFee),
        u32(finalityThreshold),
        encodeVec(hookData),
      ])
    : Buffer.concat([
        DEPOSIT_DISCRIMINATOR,
        u64(amount),
        u32(destDomain),
        mintRecipient.toBuffer(),
        destinationCaller.toBuffer(),
        u64(maxFee),
        u32(finalityThreshold),
      ])

  const keys = [
    { pubkey: owner, isSigner: true, isWritable: false },
    { pubkey: eventRentPayer, isSigner: true, isWritable: true },
    { pubkey: pda([Buffer.from('sender_authority')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: burnTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from('denylist_account'), owner.toBuffer()], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('message_transmitter')], MESSAGE_TRANSMITTER), isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from('token_messenger')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('remote_token_messenger'), Buffer.from(String(destDomain))], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('token_minter')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('local_token'), usdcMint.toBuffer()], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: true },
    { pubkey: usdcMint, isSigner: false, isWritable: true },
    { pubkey: messageSentEventData, isSigner: true, isWritable: true },
    { pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('__event_authority')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({ programId: TOKEN_MESSENGER_MINTER, keys, data })
}

function receiveInstruction(opts: {
  payer: PublicKey
  message: Buffer
  attestation: Buffer
  sourceDomain: number
  nonce: Buffer
  burnToken: Buffer
  usdcMint: PublicKey
  recipientAta: PublicKey
  feeRecipientAta: PublicKey
}): TransactionInstruction {
  const { payer, message, attestation, sourceDomain, nonce, burnToken, usdcMint, recipientAta, feeRecipientAta } = opts
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: pda([Buffer.from('message_transmitter_authority'), TOKEN_MESSENGER_MINTER.toBuffer()], MESSAGE_TRANSMITTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('message_transmitter')], MESSAGE_TRANSMITTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('used_nonce'), nonce], MESSAGE_TRANSMITTER), isSigner: false, isWritable: true },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('__event_authority')], MESSAGE_TRANSMITTER), isSigner: false, isWritable: false },
    { pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
    // remaining accounts forwarded to TokenMessengerMinter#handle_receive_finalized_message
    { pubkey: pda([Buffer.from('token_messenger')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('remote_token_messenger'), Buffer.from(String(sourceDomain))], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('token_minter')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from('local_token'), usdcMint.toBuffer()], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from('token_pair'), Buffer.from(String(sourceDomain)), burnToken], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
    { pubkey: recipientAta, isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from('custody'), usdcMint.toBuffer()], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from('__event_authority')], TOKEN_MESSENGER_MINTER), isSigner: false, isWritable: false },
    { pubkey: TOKEN_MESSENGER_MINTER, isSigner: false, isWritable: false },
  ]
  const data = Buffer.concat([RECEIVE_DISCRIMINATOR, encodeVec(message), encodeVec(attestation)])
  return new TransactionInstruction({ programId: MESSAGE_TRANSMITTER, keys, data })
}

export const solanaDriver: CanaryDriver = {
  type: 'solana',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  defaultMinNative: 10_000_000n, // 0.01 SOL

  address(secret) {
    return keypairFromSecret(secret).publicKey.toBase58()
  },

  async nativeBalance(chain, address) {
    return BigInt(await connection(chain).getBalance(new PublicKey(address)))
  },

  async usdcBalance(chain, address) {
    const owner = new PublicKey(address)
    const ata = usdcAta(owner, new PublicKey(chain.usdc_address))
    const conn = connection(chain)
    const info = await conn.getAccountInfo(ata)
    if (!info) return 0n
    const res = await conn.getTokenAccountBalance(ata)
    return BigInt(res.value.amount)
  },

  async burn(ctx: DriverContext, req: BurnRequest): Promise<string> {
    const { chain, version, amountUnits, destDomain, destChain, destAddress, fast, secret } = req
    if (version !== 2) throw new Error('Solana testnet only supports CCTP v2')

    const owner = keypairFromSecret(secret)
    const conn = connection(chain)
    const usdcMint = new PublicKey(chain.usdc_address)
    const ownerAta = usdcAta(owner.publicKey, usdcMint)
    const eventRentPayer = owner.publicKey

    let mintRecipient: PublicKey
    let hookData: Uint8Array | undefined
    if (destChain.chain_type === 'stellar' && destAddress.startsWith('G')) {
      hookData = buildHookDataForStellar(destAddress)
      mintRecipient = readMintRecipient(STELLAR_CCTP_FORWARDER.testnet)
    } else {
      mintRecipient = readMintRecipient(destAddress)
    }

    const finalityThreshold = fast ? 1000 : 2000
    const maxFee = await fetchCircleMaxFee({
      mode: 'testnet',
      srcDomain: chain.domain,
      destDomain,
      finalityThreshold,
      amountUnits,
    })

    const messageSentEventData = Keypair.generate()
    const instruction = depositInstruction({
      amount: amountUnits,
      owner: owner.publicKey,
      eventRentPayer,
      burnTokenAccount: ownerAta,
      destDomain,
      mintRecipient,
      destinationCaller: EMPTY_PUBKEY,
      maxFee,
      finalityThreshold,
      hookData,
      messageSentEventData: messageSentEventData.publicKey,
      usdcMint,
    })

    const tx = new Transaction()
    tx.add(ensureAtaInstruction(owner.publicKey, usdcMint, ownerAta))
    tx.add(instruction)
    ctx.log(`${chain.name}: burning ${amountUnits} USDC units -> domain ${destDomain}`)
    return await sendAndConfirmTransaction(conn, tx, [owner, messageSentEventData], { commitment: 'confirmed' })
  },

  async claim(ctx: DriverContext, req: ClaimRequest): Promise<string> {
    const { chain, version, message, attestation, secret } = req
    if (version !== 2) throw new Error('Solana testnet only supports CCTP v2')

    const payer = keypairFromSecret(secret)
    const conn = connection(chain)
    const usdcMint = new PublicKey(chain.usdc_address)
    const recipientAta = usdcAta(payer.publicKey, usdcMint)

    const parsed = parseMessage(message)
    const feeRecipient = await readFeeRecipient(chain)
    const feeRecipientAta = usdcAta(feeRecipient, usdcMint)

    const instruction = receiveInstruction({
      payer: payer.publicKey,
      message: Buffer.from(message.replace(/^0x/, ''), 'hex'),
      attestation: Buffer.from(attestation.replace(/^0x/, ''), 'hex'),
      sourceDomain: parsed.sourceDomain,
      nonce: parsed.nonce,
      burnToken: parsed.burnToken,
      usdcMint,
      recipientAta,
      feeRecipientAta,
    })

    const tx = new Transaction()
    tx.add(ensureAtaInstruction(payer.publicKey, usdcMint, recipientAta))
    tx.add(instruction)
    ctx.log(`${chain.name}: claiming CCTP v2 message from domain ${parsed.sourceDomain}`)
    return await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' })
  },
}
