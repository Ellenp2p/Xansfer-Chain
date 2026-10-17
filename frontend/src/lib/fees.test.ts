import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCircleMaxFee,
  formatUsdcUnits,
  getUsdcAmountError,
  parseUsdcUnits,
} from './fees'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('parseUsdcUnits', () => {
  it('converts decimal strings exactly', () => {
    expect(parseUsdcUnits('1')).toBe(1_000_000n)
    expect(parseUsdcUnits('0.29')).toBe(290_000n)
    expect(parseUsdcUnits('12.345678')).toBe(12_345_678n)
    expect(parseUsdcUnits('0.000001')).toBe(1n)
  })

  it('rejects malformed values', () => {
    for (const bad of ['', '1e3', '-1', '1.', '.5', '1.1234567', 'abc']) {
      expect(() => parseUsdcUnits(bad)).toThrow()
    }
  })
})

describe('formatUsdcUnits', () => {
  it('formats without floating point', () => {
    expect(formatUsdcUnits(1_000_000n)).toBe('1')
    expect(formatUsdcUnits(290_000n)).toBe('0.29')
    expect(formatUsdcUnits(1n)).toBe('0.000001')
    expect(formatUsdcUnits(12_345_678n)).toBe('12.345678')
  })

  it('round-trips very large amounts', () => {
    const units = 1_155_172_147_826_424_400_000_000n
    expect(parseUsdcUnits(formatUsdcUnits(units))).toBe(units)
  })
})

describe('getUsdcAmountError', () => {
  it('accepts valid amounts', () => {
    expect(getUsdcAmountError('1')).toBeNull()
    expect(getUsdcAmountError('0.000001')).toBeNull()
  })

  it('rejects invalid amounts', () => {
    expect(getUsdcAmountError('')).not.toBeNull()
    expect(getUsdcAmountError('0')).not.toBeNull()
    expect(getUsdcAmountError('1.1234567')).not.toBeNull()
    expect(getUsdcAmountError('1e3')).not.toBeNull()
  })
})

describe('fetchCircleMaxFee', () => {
  const baseArgs = {
    mode: 'testnet' as const,
    srcDomain: 6,
    destDomain: 0,
    finalityThreshold: 1000,
    amountUnits: 1_000_000n,
  }

  it('converts basis points to USDC units', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { finalityThreshold: 1000, minimumFee: 1 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCircleMaxFee(baseArgs)).resolves.toBe(100n)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/0',
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('returns 0 when the API has no fee for this threshold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])))
    await expect(fetchCircleMaxFee(baseArgs)).resolves.toBe(0n)
  })

  it('throws on HTTP errors instead of silently using zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 500)))
    await expect(fetchCircleMaxFee(baseArgs)).rejects.toThrow('HTTP 500')
  })

  it('throws on unexpected payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ nope: true })))
    await expect(fetchCircleMaxFee(baseArgs)).rejects.toThrow('Unexpected Circle fee API response')
  })

  it('throws on network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(fetchCircleMaxFee(baseArgs)).rejects.toThrow('Failed to fetch Circle fee')
  })

  it('uses the mainnet base URL for mainnet mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    await fetchCircleMaxFee({ ...baseArgs, mode: 'mainnet' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://iris-api.circle.com/v2/burn/USDC/fees/6/0',
      expect.anything(),
    )
  })
})
