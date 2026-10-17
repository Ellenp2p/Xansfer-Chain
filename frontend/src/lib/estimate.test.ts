import { describe, expect, it } from 'vitest'
import { estimateTransferSeconds, formatSeconds, lookupEstimatedWait } from './estimate'

describe('lookupEstimatedWait', () => {
  it('returns known per-chain waits by CCTP version', () => {
    expect(lookupEstimatedWait(0, 1, false)).toBe(1020)
    expect(lookupEstimatedWait(6, 2, false)).toBe(1020)
    expect(lookupEstimatedWait(6, 2, true)).toBe(8)
    expect(lookupEstimatedWait(27, 2, false)).toBe(5)
  })

  it('defaults the version from the transfer speed', () => {
    expect(lookupEstimatedWait(5, undefined, false)).toBe(25)
    expect(lookupEstimatedWait(5, undefined, true)).toBe(8)
  })

  it('falls back for unknown domains', () => {
    expect(lookupEstimatedWait(9999, 2, false)).toBe(1080)
    expect(lookupEstimatedWait(9999, 2, true)).toBe(30)
    expect(lookupEstimatedWait(undefined, 2, false)).toBe(1080)
  })

  it('falls back when the chain/version entry is missing', () => {
    // Ethereum has no CCTP v2 fast entry in the table; fast falls back to 30s.
    expect(lookupEstimatedWait(0, 2, true)).toBe(30)
  })
})

describe('estimateTransferSeconds', () => {
  it('adds one destination block to the attestation wait', () => {
    // Base -> Ethereum: 1020s attestation + 12s block time.
    expect(
      estimateTransferSeconds({
        sourceDomain: 6,
        destDomain: 0,
        cctpVersion: 2,
        transferType: 'standard',
        mode: 'mainnet',
      }),
    ).toBe(1032)
  })

  it('uses fast waits when requested', () => {
    expect(
      estimateTransferSeconds({
        sourceDomain: 6,
        destDomain: 0,
        cctpVersion: 2,
        transferType: 'fast',
        mode: 'mainnet',
      }),
    ).toBe(20)
  })
})

describe('formatSeconds', () => {
  it('formats seconds, minutes and mixed values', () => {
    expect(formatSeconds(8)).toBe('8s')
    expect(formatSeconds(59)).toBe('59s')
    expect(formatSeconds(60)).toBe('1m')
    expect(formatSeconds(90)).toBe('1m 30s')
    expect(formatSeconds(1020)).toBe('17m')
  })
})
