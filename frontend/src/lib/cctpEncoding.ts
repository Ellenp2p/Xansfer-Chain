import { hexToBytes, stringToBytes, toHex, type Hex } from 'viem'

// Shared CCTP address / hook-data encoding. These helpers sit on the boundary
// between a user-entered destination address and a burn transaction, so they
// must stay identical across EVM, Aptos, Sui and Stellar adapters.

const STELLAR_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a Stellar strkey (base32 + version + checksum) into raw bytes. */
export function stellarStrKeyDecode(strkey: string): Uint8Array {
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

/** Convert a Stellar contract strkey (C...) to a bytes32 hex contract id. */
export function contractStrKeyToBytes32(strkey: string): Hex {
  if (!strkey.startsWith('C') || strkey.length !== 56) {
    throw new Error(`Invalid Stellar contract strkey: ${strkey}`)
  }
  const decoded = stellarStrKeyDecode(strkey)
  // Contract strkey: version(1) + contract_id(32) + checksum(2) = 35 bytes.
  return toHex(decoded.slice(1, 33), { size: 32 })
}

export function buildCctpForwarderHookDataBytes(forwardRecipient: string): Uint8Array {
  const recipientBytes = stringToBytes(forwardRecipient)
  const hookData = new Uint8Array(32 + recipientBytes.length)
  // Bytes 24-27: hook version = 0 (zero-initialized).
  // Bytes 28-31: recipient byte length (big-endian uint32).
  hookData[28] = (recipientBytes.length >>> 24) & 0xff
  hookData[29] = (recipientBytes.length >>> 16) & 0xff
  hookData[30] = (recipientBytes.length >>> 8) & 0xff
  hookData[31] = recipientBytes.length & 0xff
  // Bytes 32+: recipient strkey as UTF-8.
  hookData.set(recipientBytes, 32)
  return hookData
}

/** CCTP Forwarder hookData: [24 zero bytes][4-byte version][4-byte len][strkey]. */
export function buildCctpForwarderHookData(forwardRecipient: string): Hex {
  return toHex(buildCctpForwarderHookDataBytes(forwardRecipient))
}

/**
 * CCTP mint_recipient for a non-Move destination must be a 32-byte address.
 * EVM addresses (20 bytes) are left-padded; Sui/Aptos addresses are already 32.
 */
export function normalizeMintRecipient(addr: string): Hex {
  const clean = addr.replace(/^0x/i, '').toLowerCase()
  if (clean.length === 64) return `0x${clean}`
  return `0x${clean.padStart(64, '0')}`
}

/** Re-exported for callers that need raw bytes from a normalized recipient. */
export function mintRecipientBytes(addr: string): Uint8Array {
  return hexToBytes(normalizeMintRecipient(addr))
}
