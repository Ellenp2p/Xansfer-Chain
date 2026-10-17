import { describe, expect, it } from 'vitest'
import { isPlausibleDestTxHash } from './api'

const EVM_HASH = '0x' + 'ab'.repeat(32)
const STELLAR_HASH = 'ab'.repeat(32)
const SOLANA_HASH = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

describe('isPlausibleDestTxHash', () => {
  it('accepts 0x hashes for EVM-like chains', () => {
    for (const domain of [0, 6, 8, 9, 25]) {
      expect(isPlausibleDestTxHash(EVM_HASH, domain, 'testnet')).toBe(true)
    }
  })

  it('accepts bare hex for Stellar', () => {
    expect(isPlausibleDestTxHash(STELLAR_HASH, 27, 'testnet')).toBe(true)
    expect(isPlausibleDestTxHash(EVM_HASH, 27, 'testnet')).toBe(false)
  })

  it('accepts base58 for Solana', () => {
    expect(isPlausibleDestTxHash(SOLANA_HASH, 5, 'testnet')).toBe(true)
    expect(isPlausibleDestTxHash('too-short', 5, 'testnet')).toBe(false)
  })

  it('rejects malformed hashes', () => {
    expect(isPlausibleDestTxHash('0x1234', 0, 'testnet')).toBe(false)
    expect(isPlausibleDestTxHash('', 0, 'testnet')).toBe(false)
  })
})
