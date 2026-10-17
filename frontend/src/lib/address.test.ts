import { describe, expect, it } from 'vitest'
import {
  getDestinationAddressError,
  isValidEvmAddress,
  isValidMoveAddress,
  isValidStellarAccount,
  isValidStellarContract,
} from './address'

const EVM_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const APTOS_USDC = '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832'
const STELLAR_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const STELLAR_ACCOUNT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

describe('EVM address validation', () => {
  it('accepts lowercase and checksummed addresses', () => {
    expect(isValidEvmAddress(EVM_USDC)).toBe(true)
    expect(isValidEvmAddress(EVM_USDC.toLowerCase())).toBe(true)
    expect(isValidEvmAddress(EVM_USDC.toUpperCase().replace('0X', '0x'))).toBe(true)
  })

  it('rejects bad checksums and wrong lengths', () => {
    expect(isValidEvmAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4A')).toBe(false)
    expect(isValidEvmAddress(APTOS_USDC)).toBe(false)
    expect(isValidEvmAddress(EVM_USDC.slice(0, -2))).toBe(false)
    expect(isValidEvmAddress('not-an-address')).toBe(false)
  })
})

describe('Move address validation', () => {
  it('requires exactly 64 hex characters', () => {
    expect(isValidMoveAddress(APTOS_USDC)).toBe(true)
    expect(isValidMoveAddress(APTOS_USDC.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isValidMoveAddress(EVM_USDC)).toBe(false)
    expect(isValidMoveAddress(APTOS_USDC.slice(0, -2))).toBe(false)
  })
})

describe('Stellar address validation', () => {
  it('validates contract and account strkeys', () => {
    expect(isValidStellarContract(STELLAR_CONTRACT)).toBe(true)
    expect(isValidStellarAccount(STELLAR_ACCOUNT)).toBe(true)
    expect(isValidStellarAccount(STELLAR_CONTRACT)).toBe(false)
    expect(isValidStellarContract(STELLAR_ACCOUNT)).toBe(false)
  })

  it('rejects a corrupted checksum', () => {
    const corrupted = STELLAR_CONTRACT.slice(0, -1) + 'A'
    expect(isValidStellarContract(corrupted)).toBe(false)
  })
})

describe('getDestinationAddressError', () => {
  it('accepts valid EVM addresses', () => {
    expect(getDestinationAddressError(EVM_USDC, 'evm', 'mainnet')).toBeNull()
  })

  it('accepts Move addresses for aptos and sui', () => {
    expect(getDestinationAddressError(APTOS_USDC, 'aptos', 'mainnet')).toBeNull()
    expect(getDestinationAddressError(APTOS_USDC, 'sui', 'mainnet')).toBeNull()
  })

  it('allows Stellar accounts on testnet but not mainnet', () => {
    expect(getDestinationAddressError(STELLAR_ACCOUNT, 'stellar', 'testnet')).toBeNull()
    expect(getDestinationAddressError(STELLAR_ACCOUNT, 'stellar', 'mainnet')).not.toBeNull()
    expect(getDestinationAddressError(STELLAR_CONTRACT, 'stellar', 'mainnet')).toBeNull()
  })

  it('rejects unsupported destination chains', () => {
    expect(getDestinationAddressError('anything', 'solana', 'testnet')).not.toBeNull()
    expect(getDestinationAddressError('anything', 'starknet', 'testnet')).not.toBeNull()
  })

  it('rejects empty input and tolerates surrounding whitespace', () => {
    expect(getDestinationAddressError('   ', 'evm', 'mainnet')).not.toBeNull()
    expect(getDestinationAddressError(`  ${EVM_USDC}  `, 'evm', 'mainnet')).toBeNull()
  })
})
