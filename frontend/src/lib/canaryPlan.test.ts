import { describe, expect, it } from 'vitest'
import {
  buildCanaryPlan,
  chainSlug,
  HARD_MAX_AMOUNT_USDC,
  HARD_MAX_TRANSFERS,
  parseRoute,
  validateAmount,
  type CanaryChain,
} from './canaryPlan'

const chains: CanaryChain[] = [
  { domain: 0, name: 'Ethereum Sepolia', chain_type: 'evm', chain_id: 11155111, cctp_versions: [1, 2] },
  { domain: 3, name: 'Arbitrum Sepolia', chain_type: 'evm', chain_id: 421614, cctp_versions: [2] },
  { domain: 6, name: 'Base Sepolia', chain_type: 'evm', chain_id: 84532, cctp_versions: [2] },
  { domain: 8, name: 'Sui Testnet', chain_type: 'sui', chain_id: null, cctp_versions: [1] },
  { domain: 99, name: 'Legacy EVM', chain_type: 'evm', chain_id: 99, cctp_versions: [1] },
]

describe('chainSlug', () => {
  it('normalises chain names', () => {
    expect(chainSlug('Base Sepolia')).toBe('base-sepolia')
    expect(chainSlug('  OP  Sepolia ')).toBe('op-sepolia')
  })
})

describe('parseRoute', () => {
  it('resolves chains by slug or domain', () => {
    expect(parseRoute('base-sepolia->ethereum-sepolia', chains).from.domain).toBe(6)
    expect(parseRoute('6->0', chains).to.domain).toBe(0)
  })

  it('rejects unknown, non-EVM, v1-only and same-chain routes', () => {
    expect(() => parseRoute('base-sepolia->nope', chains)).toThrow(/Unknown chain/)
    expect(() => parseRoute('base-sepolia->sui-testnet', chains)).toThrow(/not EVM/)
    expect(() => parseRoute('base-sepolia->legacy-evm', chains)).toThrow(/does not support CCTP v2/)
    expect(() => parseRoute('base-sepolia->base-sepolia', chains)).toThrow(/same chain/)
    expect(() => parseRoute('base-sepolia', chains)).toThrow(/Invalid route/)
  })
})

describe('validateAmount', () => {
  it('accepts amounts within the hard cap', () => {
    expect(() => validateAmount('0.01')).not.toThrow()
    expect(() => validateAmount(String(HARD_MAX_AMOUNT_USDC))).not.toThrow()
  })

  it('rejects zero, malformed and oversized amounts', () => {
    expect(() => validateAmount('0')).toThrow(/greater than 0/)
    expect(() => validateAmount('1e3')).toThrow(/Invalid amount/)
    expect(() => validateAmount('0.1234567')).toThrow(/Invalid amount/)
    expect(() => validateAmount('1')).toThrow(/hard cap/)
    expect(() => validateAmount('0.051')).toThrow(/hard cap/)
  })
})

describe('buildCanaryPlan', () => {
  it('builds a single-leg distribute plan by default', () => {
    const plan = buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      chains,
    })
    expect(plan).toEqual([{ fromDomain: 6, toDomain: 0, amountUsdc: '0.01' }])
  })

  it('enforces the per-run transfer limit', () => {
    expect(() => buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->ethereum-sepolia', 'arbitrum-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      chains,
    })).toThrow(/per-run limit is 1/)

    expect(buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->ethereum-sepolia', 'arbitrum-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      maxTransfers: 2,
      chains,
    })).toHaveLength(2)
  })

  it('rejects a transfer budget above the hard cap', () => {
    expect(() => buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      maxTransfers: HARD_MAX_TRANSFERS + 1,
      chains,
    })).toThrow(/hard cap/)
  })

  it('rejects a non-finite transfer budget', () => {
    expect(() => buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      maxTransfers: Number.NaN,
      chains,
    })).toThrow(/positive number/)
  })

  it('requires collect routes to share a destination', () => {
    expect(() => buildCanaryPlan({
      mode: 'collect',
      routes: ['base-sepolia->ethereum-sepolia', 'arbitrum-sepolia->base-sepolia'],
      amountUsdc: '0.01',
      maxTransfers: 2,
      chains,
    })).toThrow(/same destination/)

    expect(buildCanaryPlan({
      mode: 'collect',
      routes: ['base-sepolia->ethereum-sepolia', 'arbitrum-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      maxTransfers: 2,
      chains,
    })).toHaveLength(2)
  })

  it('turns a roundtrip into two legs and enforces the budget', () => {
    const plan = buildCanaryPlan({
      mode: 'roundtrip',
      routes: ['base-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      chains,
    })
    expect(plan).toEqual([
      { fromDomain: 6, toDomain: 0, amountUsdc: '0.01' },
      { fromDomain: 0, toDomain: 6, amountUsdc: '0.01' },
    ])

    expect(() => buildCanaryPlan({
      mode: 'roundtrip',
      routes: ['base-sepolia->ethereum-sepolia'],
      amountUsdc: '0.01',
      maxTransfers: 1,
      chains,
    })).toThrow(/per-run limit is 1/)
  })

  it('propagates the amount guard', () => {
    expect(() => buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->ethereum-sepolia'],
      amountUsdc: '1',
      chains,
    })).toThrow(/hard cap/)
  })
})
