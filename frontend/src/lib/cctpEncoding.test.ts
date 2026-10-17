import { describe, expect, it } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { bytesToHex, hexToBytes } from 'viem'
import {
  buildCctpForwarderHookData,
  buildCctpForwarderHookDataBytes,
  contractStrKeyToBytes32,
  mintRecipientBytes,
  normalizeMintRecipient,
} from './cctpEncoding'

const STELLAR_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const STELLAR_ACCOUNT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const EVM_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

describe('normalizeMintRecipient', () => {
  it('left-pads 20-byte EVM addresses to bytes32', () => {
    const normalized = normalizeMintRecipient(EVM_ADDRESS)
    expect(normalized).toBe('0x' + '0'.repeat(24) + EVM_ADDRESS.slice(2).toLowerCase())
    expect(normalized).toHaveLength(66)
  })

  it('passes through 32-byte addresses', () => {
    const bytes32 = '0x' + '12'.repeat(32)
    expect(normalizeMintRecipient(bytes32)).toBe(bytes32)
  })

  it('accepts uppercase 0X prefixes', () => {
    expect(normalizeMintRecipient(EVM_ADDRESS.replace('0x', '0X'))).toMatch(/^0x0{24}/)
  })
})

describe('contractStrKeyToBytes32', () => {
  it('decodes a Stellar contract strkey', () => {
    expect(contractStrKeyToBytes32(STELLAR_CONTRACT)).toBe(
      bytesToHex(StrKey.decodeContract(STELLAR_CONTRACT)),
    )
  })

  it('rejects account strkeys and malformed values', () => {
    expect(() => contractStrKeyToBytes32(STELLAR_ACCOUNT)).toThrow()
    expect(() => contractStrKeyToBytes32('C123')).toThrow()
  })
})

describe('buildCctpForwarderHookData', () => {
  it('encodes version, length and recipient according to the Forwarder ABI', () => {
    const bytes = buildCctpForwarderHookDataBytes(STELLAR_ACCOUNT)
    expect(bytes).toHaveLength(32 + STELLAR_ACCOUNT.length)
    expect(bytes.slice(0, 24)).toEqual(new Uint8Array(24))
    expect(bytes.slice(24, 28)).toEqual(new Uint8Array(4))
    expect(bytes[28]).toBe(0)
    expect(bytes[29]).toBe(0)
    expect(bytes[30]).toBe(0)
    expect(bytes[31]).toBe(STELLAR_ACCOUNT.length)
    expect(new TextDecoder().decode(bytes.slice(32))).toBe(STELLAR_ACCOUNT)
    expect(buildCctpForwarderHookData(STELLAR_ACCOUNT)).toBe(bytesToHex(bytes))
  })
})

describe('mintRecipientBytes', () => {
  it('returns 32 bytes with the EVM address in the low bytes', () => {
    const bytes = mintRecipientBytes(EVM_ADDRESS)
    expect(bytes).toHaveLength(32)
    expect(bytesToHex(bytes.slice(12))).toBe(EVM_ADDRESS.toLowerCase())
    expect(bytes.slice(0, 12)).toEqual(new Uint8Array(12))
  })

  it('round-trips the normalized hex', () => {
    expect(bytesToHex(mintRecipientBytes(EVM_ADDRESS))).toBe(normalizeMintRecipient(EVM_ADDRESS))
    expect(hexToBytes(normalizeMintRecipient(EVM_ADDRESS))).toEqual(mintRecipientBytes(EVM_ADDRESS))
  })
})
