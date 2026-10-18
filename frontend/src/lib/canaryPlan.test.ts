import { describe, expect, it } from 'vitest'
import {
  buildCanaryPlan,
  CANARY_DRIVER_TYPES,
  chainSlug,
  commonVersion,
  HARD_MAX_AMOUNT_USDC,
  HARD_MAX_TRANSFERS,
  parseDriverList,
  parseRoute,
  validateAmount,
  type CanaryChain,
} from './canaryPlan'

const chains: CanaryChain[] = [
  { domain: 0, name: 'Ethereum Sepolia', chain_type: 'evm', chain_id: 11155111, cctp_versions: [1, 2] },
  { domain: 3, name: 'Arbitrum Sepolia', chain_type: 'evm', chain_id: 421614, cctp_versions: [2] },
  { domain: 6, name: 'Base Sepolia', chain_type: 'evm', chain_id: 84532, cctp_versions: [2] },
  { domain: 8, name: 'Sui Testnet', chain_type: 'sui', chain_id: null, cctp_versions: [1] },
  { domain: 9, name: 'Aptos Testnet', chain_type: 'aptos', chain_id: null, cctp_versions: [2] },
  { domain: 27, name: 'Stellar Testnet', chain_type: 'stellar', chain_id: null, cctp_versions: [2] },
  { domain: 5, name: 'Solana Devnet', chain_type: 'solana', chain_id: null, cctp_versions: [2] },
  { domain: 25, name: 'Starknet Sepolia', chain_type: 'starknet', chain_id: null, cctp_versions: [2] },
  { domain: 99, name: 'Legacy EVM', chain_type: 'evm', chain_id: 99, cctp_versions: [1] },
]

describe('chainSlug', () => {
  it('normalises chain names', () => {
    expect(chainSlug('Base Sepolia')).toBe('base-sepolia')
    expect(chainSlug('  OP  Sepolia ')).toBe('op-sepolia')
  })
})

describe('parseDriverList', () => {
  it('defaults to every driver', () => {
    expect(parseDriverList(undefined)).toEqual([...CANARY_DRIVER_TYPES])
    expect(parseDriverList('all')).toEqual([...CANARY_DRIVER_TYPES])
  })

  it('parses and validates driver names', () => {
    expect(parseDriverList('evm, aptos')).toEqual(['evm', 'aptos'])
    expect(() => parseDriverList('evm,nope')).toThrow(/Unknown canary driver/)
  })
})

describe('commonVersion', () => {
  it('picks the highest shared version', () => {
    expect(commonVersion(chains[0], chains[1])).toBe(2)
    expect(commonVersion(chains[0], chains[3])).toBe(1)
  })

  it('rejects disjoint version sets', () => {
    expect(() => commonVersion(chains[3], chains[4])).toThrow(/no CCTP version in common/)
  })
})

describe('parseRoute', () => {
  it('resolves chains by slug or domain and records the version', () => {
    expect(parseRoute('base-sepolia->ethereum-sepolia', chains)).toMatchObject({
      version: 2,
      from: { domain: 6 },
      to: { domain: 0 },
    })
    expect(parseRoute('6->0', chains).to.domain).toBe(0)
    expect(parseRoute('ethereum-sepolia->sui-testnet', chains).version).toBe(1)
    expect(parseRoute('base-sepolia->aptos-testnet', chains).version).toBe(2)
  })

  it('rejects unknown, undriven, disjoint-version and same-chain routes', () => {
    expect(() => parseRoute('base-sepolia->nope', chains)).toThrow(/Unknown chain/)
    expect(() => parseRoute('base-sepolia->sui-testnet', chains, ['evm'])).toThrow(/no canary driver/)
    expect(() => parseRoute('base-sepolia->legacy-evm', chains)).toThrow(/no CCTP version in common/)
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
    expect(plan).toEqual([{ fromDomain: 6, toDomain: 0, version: 2, amountUsdc: '0.01' }])
  })

  it('plans every chain type with the right CCTP version', () => {
    const plan = buildCanaryPlan({
      mode: 'distribute',
      routes: [
        'ethereum-sepolia->sui-testnet',
        'base-sepolia->aptos-testnet',
        'aptos-testnet->stellar-testnet',
      ],
      amountUsdc: '0.01',
      maxTransfers: 3,
      chains,
    })
    expect(plan.map((leg) => [leg.fromDomain, leg.toDomain, leg.version])).toEqual([
      [0, 8, 1],
      [6, 9, 2],
      [9, 27, 2],
    ])
  })

  it('honours a narrowed driver list', () => {
    expect(() => buildCanaryPlan({
      mode: 'distribute',
      routes: ['base-sepolia->aptos-testnet'],
      amountUsdc: '0.01',
      supportedTypes: ['evm'],
      chains,
    })).toThrow(/no canary driver/)
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
      { fromDomain: 6, toDomain: 0, version: 2, amountUsdc: '0.01' },
      { fromDomain: 0, toDomain: 6, version: 2, amountUsdc: '0.01' },
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
