/**
 * One BIP39 mnemonic -> one wallet per chain (index 0 = primary, index 1 = receiver).
 *
 * Derivation is intentionally explicit and pinned by tests:
 *   EVM      m/44'/60'/0'/0/{i}        (viem / secp256k1 BIP32)
 *   Aptos    m/44'/637'/0'/0'/{i}'     (SLIP-0010 ed25519)
 *   Sui      m/44'/784'/0'/0'/{i}'     (SLIP-0010 ed25519)
 *   Stellar  m/44'/148'/{i}'           (SEP-0005, SLIP-0010 ed25519)
 *   Solana   m/44'/501'/{i}'/0'        (SLIP-0010 ed25519)
 *
 * Starknet is not derivable from the key alone: the account address depends on
 * the account class hash / wallet implementation. Callers must supply
 * `CANARY_STARKNET_ADDRESS` (and `CANARY_STARKNET_PRIVATE_KEY`) instead.
 *
 * Pure module: no I/O, no network. Safe to unit test and to import from scripts.
 */

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha512'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils'
import { mnemonicToAccount } from 'viem/accounts'
import { Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Keypair as StellarKeypair } from '@stellar/stellar-sdk'
import { Keypair as SolanaKeypair } from '@solana/web3.js'

/** Chain types whose key can be derived from the mnemonic. */
export const DERIVABLE_CHAIN_TYPES = ['evm', 'aptos', 'sui', 'stellar', 'solana'] as const
export type DerivableChainType = (typeof DERIVABLE_CHAIN_TYPES)[number]

export function isDerivableChainType(value: string): value is DerivableChainType {
  return (DERIVABLE_CHAIN_TYPES as readonly string[]).includes(value)
}

/** Derivation path templates. `{i}` is replaced with the account index. */
export const DERIVATION_PATHS: Record<DerivableChainType, string> = {
  evm: "m/44'/60'/0'/0/{i}",
  aptos: "m/44'/637'/0'/0'/{i}'",
  sui: "m/44'/784'/0'/0'/{i}'",
  stellar: "m/44'/148'/{i}'",
  solana: "m/44'/501'/{i}'/0'",
}

export interface DerivedWallet {
  chainType: string
  index: number
  /** Human-readable derivation path, or null when the chain cannot derive. */
  path: string | null
  /** Public address the canary will use on this chain. */
  address: string
  /**
   * Signing secret in the exact format the canary driver expects.
   * Never log this. Null for chains that cannot derive from the mnemonic.
   */
  secret: string | null
  derived: boolean
}

export interface DeriveOptions {
  /** Account index. 0 = primary canary wallet, 1 = receiver. */
  index?: number
  /** Optional BIP39 passphrase ("25th word"); must stay constant per campaign. */
  passphrase?: string
  /** Override a derivation path template for a chain type. */
  paths?: Partial<Record<string, string>>
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function assertMnemonic(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic)
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error('CANARY_MNEMONIC is not a valid BIP39 english mnemonic')
  }
  return normalized
}

export function derivationPath(chainType: string, index: number, paths?: Partial<Record<string, string>>): string | null {
  const template = paths?.[chainType] ?? DERIVATION_PATHS[chainType as DerivableChainType]
  if (!template) return null
  return template.replace(/\{i\}/g, String(index))
}

/** Parse a hardened-only ed25519 path like `m/44'/148'/0'` into indices. */
function parseEd25519Path(path: string): number[] {
  const parts = path.split('/').slice(1)
  return parts.map((part) => {
    if (!part.endsWith("'")) {
      throw new Error(`ed25519 derivation paths must be fully hardened: ${path}`)
    }
    const value = Number(part.slice(0, -1))
    if (!Number.isInteger(value) || value < 0 || value >= 0x80000000) {
      throw new Error(`invalid hardened index in path: ${path}`)
    }
    return value
  })
}

const ED25519_CURVE = utf8ToBytes('ed25519 seed')
const HARDENED_OFFSET = 0x80000000

function ser32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = (value >>> 24) & 0xff
  out[1] = (value >>> 16) & 0xff
  out[2] = (value >>> 8) & 0xff
  out[3] = value & 0xff
  return out
}

/** SLIP-0010 ed25519 key derivation (hardened only), returns the 32-byte key. */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  let digest = hmac(sha512, ED25519_CURVE, seed)
  let key = digest.slice(0, 32)
  let chainCode = digest.slice(32)
  for (const index of parseEd25519Path(path)) {
    digest = hmac(sha512, chainCode, concatBytes(new Uint8Array([0]), key, ser32(index + HARDENED_OFFSET)))
    key = digest.slice(0, 32)
    chainCode = digest.slice(32)
  }
  return key
}

function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function deriveEvm(mnemonic: string, index: number, passphrase: string | undefined): { address: string; secret: string } {
  const account = mnemonicToAccount(mnemonic, { addressIndex: index, passphrase })
  const privateKey = account.getHdKey().privateKey
  if (!privateKey) throw new Error('viem did not expose the derived EVM private key')
  return { address: account.address, secret: toHex(privateKey) }
}

/**
 * Derive one wallet. Throws for chains that cannot be derived (Starknet).
 * Returns a `derived: false` record instead when `{ allowUnsupported: true }`.
 */
export function deriveWallet(
  mnemonic: string,
  chainType: string,
  options: DeriveOptions & { allowUnsupported?: boolean } = {},
): DerivedWallet {
  const normalized = assertMnemonic(mnemonic)
  const index = options.index ?? 0
  const passphrase = options.passphrase
  const path = derivationPath(chainType, index, options.paths)

  if (!isDerivableChainType(chainType) || !path) {
    if (options.allowUnsupported) {
      return { chainType, index, path: null, address: '', secret: null, derived: false }
    }
    throw new Error(
      `cannot derive a ${chainType} wallet from the mnemonic (address depends on the account implementation); ` +
        'set CANARY_STARKNET_ADDRESS / CANARY_STARKNET_PRIVATE_KEY instead',
    )
  }

  if (chainType === 'evm') {
    const { address, secret } = deriveEvm(normalized, index, passphrase)
    return { chainType, index, path, address, secret, derived: true }
  }

  const seed = mnemonicToSeedSync(normalized, passphrase)
  const key = slip10Ed25519(seed, path)

  if (chainType === 'aptos') {
    const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(key) })
    return { chainType, index, path, address: account.accountAddress.toStringLong(), secret: toHex(key), derived: true }
  }

  if (chainType === 'sui') {
    const keypair = Ed25519Keypair.fromSecretKey(key)
    return { chainType, index, path, address: keypair.toSuiAddress(), secret: keypair.getSecretKey(), derived: true }
  }

  if (chainType === 'stellar') {
    const keypair = StellarKeypair.fromRawEd25519Seed(Buffer.from(key))
    return { chainType, index, path, address: keypair.publicKey(), secret: keypair.secret(), derived: true }
  }

  // solana
  const keypair = SolanaKeypair.fromSeed(key)
  return {
    chainType,
    index,
    path,
    address: keypair.publicKey.toBase58(),
    secret: JSON.stringify(Array.from(keypair.secretKey)),
    derived: true,
  }
}

/** Derive wallets for every chain type (Starknet comes back as `derived: false`). */
export function deriveAllWallets(
  mnemonic: string,
  options: DeriveOptions = {},
  chainTypes: string[] = [...DERIVABLE_CHAIN_TYPES, 'starknet'],
): DerivedWallet[] {
  return chainTypes.map((chainType) => deriveWallet(mnemonic, chainType, { ...options, allowUnsupported: true }))
}
