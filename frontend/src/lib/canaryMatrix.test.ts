import { describe, expect, it } from 'vitest'
import {
  enumerateRoutes,
  pickUncovered,
  routeId,
  shardRoutes,
  summarizeCoverage,
  type MatrixChain,
} from './canaryMatrix'

const chains: MatrixChain[] = [
  { domain: 0, name: 'Ethereum Sepolia', chain_type: 'evm', chain_id: 11155111, cctp_versions: [1, 2] },
  { domain: 6, name: 'Base Sepolia', chain_type: 'evm', chain_id: 84532, cctp_versions: [2] },
  { domain: 9, name: 'Aptos Testnet', chain_type: 'aptos', chain_id: null, cctp_versions: [1, 2] },
  { domain: 8, name: 'Sui Testnet', chain_type: 'sui', chain_id: null, cctp_versions: [1] },
  { domain: 27, name: 'Stellar Testnet', chain_type: 'stellar', chain_id: null, cctp_versions: [2] },
  { domain: 5, name: 'Solana Devnet', chain_type: 'solana', chain_id: null, cctp_versions: [2] },
]

const supported = ['evm', 'aptos', 'sui', 'stellar']

describe('enumerateRoutes', () => {
  it('enumerates every supported directed route/version pair', () => {
    const routes = enumerateRoutes(chains, supported)
    expect(routes).toHaveLength(18)
    expect(routes.some((r) => r.fromType === 'solana' || r.toType === 'solana')).toBe(false)
    expect(routes).toContainEqual({
      id: routeId(0, 9, 1),
      fromDomain: 0,
      toDomain: 9,
      version: 1,
      fromType: 'evm',
      toType: 'aptos',
    })
    expect(routes).toContainEqual({
      id: routeId(27, 6, 2),
      fromDomain: 27,
      toDomain: 6,
      version: 2,
      fromType: 'stellar',
      toType: 'evm',
    })
  })

  it('excludes same-chain routes and unsupported drivers', () => {
    const routes = enumerateRoutes(chains, ['evm'])
    expect(routes).toHaveLength(2) // Ethereum Sepolia <-> Base Sepolia, v2 only
    for (const route of routes) {
      expect(route.fromDomain).not.toBe(route.toDomain)
      expect(route.fromType).toBe('evm')
      expect(route.toType).toBe('evm')
    }
  })

  it('is deterministic', () => {
    expect(enumerateRoutes(chains, supported)).toEqual(enumerateRoutes(chains, supported))
  })
})

describe('shardRoutes', () => {
  it('partitions routes without gaps or duplicates', () => {
    const routes = enumerateRoutes(chains, supported)
    const union: string[] = []
    for (let shard = 0; shard < 3; shard++) {
      union.push(...shardRoutes(routes, shard, 3).map((r) => r.id))
    }
    expect(union).toHaveLength(routes.length)
    expect(new Set(union).size).toBe(routes.length)
  })

  it('validates shard arguments', () => {
    const routes = enumerateRoutes(chains, supported)
    expect(() => shardRoutes(routes, 0, 0)).toThrow(/shardCount/)
    expect(() => shardRoutes(routes, 3, 3)).toThrow(/shardIndex/)
    expect(() => shardRoutes(routes, -1, 3)).toThrow(/shardIndex/)
  })
})

describe('coverage', () => {
  it('picks the next uncovered routes in order', () => {
    const routes = enumerateRoutes(chains, supported)
    const first = pickUncovered(routes, [], 2)
    expect(first.map((r) => r.id)).toEqual([routes[0].id, routes[1].id])

    const next = pickUncovered(routes, first.map((r) => r.id), 2)
    expect(next.map((r) => r.id)).toEqual([routes[2].id, routes[3].id])

    expect(pickUncovered(routes, routes.map((r) => r.id), 5)).toEqual([])
  })

  it('summarizes coverage overall and by chain-type pair', () => {
    const routes = enumerateRoutes(chains, supported)
    const covered = routes.slice(0, 3).map((r) => r.id)
    const summary = summarizeCoverage(routes, covered)
    expect(summary.total).toBe(18)
    expect(summary.covered).toBe(3)
    expect(summary.missing).toBe(15)
    expect(summary.byPair['evm->evm']).toEqual({ total: 2, covered: 1 })
    expect(summary.byPair['evm->sui']).toEqual({ total: 1, covered: 1 })
    expect(summary.byPair['evm->aptos']).toEqual({ total: 3, covered: 1 })
  })
})
