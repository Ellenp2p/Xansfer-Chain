import { isAddress } from 'viem'
import { StrKey } from '@stellar/stellar-sdk'
import type { ChainType } from '../types'
import type { Mode } from '../config/chains'

// ── Per-chain-type destination address validation ───────────────────────────
// The frontend is the last line of defense: a bad bytes32 mintRecipient means
// burned USDC is minted to an unrecoverable address. Validation happens in the
// form (before the user can submit) and again inside every adapter (before
// signing the burn transaction).

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MOVE_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/
const HEX_RE = /^0x[0-9a-fA-F]+$/

/** EVM: exactly 40 hex chars. Mixed-case must additionally satisfy EIP-55 checksum. */
export function isValidEvmAddress(address: string): boolean {
  if (!EVM_ADDRESS_RE.test(address)) return false
  const body = address.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true
  return isAddress(address)
}

/** Aptos / Sui: exactly 64 hex chars. */
export function isValidMoveAddress(address: string): boolean {
  return MOVE_ADDRESS_RE.test(address)
}

/** Stellar contract strkey (C...), CRC-checked. */
export function isValidStellarContract(address: string): boolean {
  try {
    return StrKey.isValidContract(address)
  } catch {
    return false
  }
}

/** Stellar account (G...) strkey, CRC-checked. */
export function isValidStellarAccount(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address)
  } catch {
    return false
  }
}

/** Loose hex check used where a raw 0x-prefixed bytes32 is expected. */
export function isValidHexString(value: string): boolean {
  return HEX_RE.test(value)
}

/**
 * Validate a destination (mint recipient) address for the given chain type.
 * Returns an error message string, or null when the address is acceptable.
 *
 * Stellar G/M (account) addresses are rejected on mainnet: the CCTP Forwarder
 * path for them is unimplemented, so a burn would mint USDC to a contract
 * that cannot release it. On testnet they are allowed (funds are worthless).
 */
export function getDestinationAddressError(
  address: string,
  chainType: ChainType,
  mode: Mode,
): string | null {
  const addr = address.trim()
  if (!addr) return 'Recipient address is required'

  switch (chainType) {
    case 'evm':
      return isValidEvmAddress(addr)
        ? null
        : 'Invalid EVM address — expected 0x followed by 40 hex characters'
    case 'aptos':
    case 'sui':
      return isValidMoveAddress(addr)
        ? null
        : `Invalid ${chainType === 'aptos' ? 'Aptos' : 'Sui'} address — expected 0x followed by 64 hex characters`
    case 'stellar':
      if (isValidStellarContract(addr)) return null
      if (isValidStellarAccount(addr)) {
        return mode === 'mainnet'
          ? 'Stellar account (G/M) addresses are not supported on mainnet — use a contract (C) address'
          : null
      }
      return 'Invalid Stellar address — expected a strkey (G..., M... or C...)'
    case 'starknet':
      return 'Starknet is not supported as a destination yet — claiming would not be possible'
    case 'solana':
      return 'Solana is not supported as a destination yet — claiming would not be possible'
    default:
      return `Unsupported destination chain type: ${chainType}`
  }
}

/** Throwing variant for use inside adapters, right before signing the burn. */
export function assertDestinationAddress(address: string, chainType: ChainType, mode: Mode): void {
  const error = getDestinationAddressError(address, chainType, mode)
  if (error) throw new Error(`[address] ${error} (got "${address.slice(0, 10)}…")`)
}
