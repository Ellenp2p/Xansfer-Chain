import { describe, expect, it } from 'vitest'
import {
  getAttestationUrl,
  getCctpContracts,
  getChainByDomain,
  getChains,
  getTransferTypes,
  modeFromPath,
  withModePrefix,
  type Mode,
} from './chains'

const MODES: Mode[] = ['mainnet', 'testnet']

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_32 = /^0x[0-9a-fA-F]{64}$/
const STARKNET_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const STELLAR_CONTRACT = /^C[A-Z2-7]{55}$/

function cctpAddressPattern(chainType: string): RegExp {
  switch (chainType) {
    case 'evm':
      return EVM_ADDRESS
    case 'aptos':
    case 'sui':
      return HEX_32
    case 'starknet':
      return STARKNET_ADDRESS
    case 'solana':
      return BASE58
    case 'stellar':
      return STELLAR_CONTRACT
    default:
      throw new Error(`Unhandled chain type: ${chainType}`)
  }
}

describe.each(MODES)('chain config (%s)', (mode) => {
  const chains = getChains(mode)

  it('has unique domains, names and EVM chain ids', () => {
    expect(chains.length).toBeGreaterThan(0)
    expect(new Set(chains.map((c) => c.domain)).size).toBe(chains.length)
    expect(new Set(chains.map((c) => c.name)).size).toBe(chains.length)
    const chainIds = chains.map((c) => c.chain_id).filter((id): id is number => id != null)
    expect(new Set(chainIds).size).toBe(chainIds.length)
  })

  it('declares valid CCTP versions', () => {
    for (const chain of chains) {
      const versions = chain.cctp_versions ?? []
      expect(versions.length).toBeGreaterThan(0)
      for (const version of versions) {
        expect([1, 2]).toContain(version)
      }
    }
  })

  it('names a well-known domain for every chain', () => {
    const expected: Record<string, number> = mode === 'mainnet'
      ? {
          Ethereum: 0,
          Avalanche: 1,
          'OP Mainnet': 2,
          Arbitrum: 3,
          Solana: 5,
          Base: 6,
          'Polygon PoS': 7,
          Sui: 8,
          Aptos: 9,
          Unichain: 10,
          Linea: 11,
          Starknet: 25,
          Stellar: 27,
          EDGE: 28,
          Injective: 29,
          Morph: 30,
          Pharos: 31,
          Cronos: 32,
        }
      : {
          'Ethereum Sepolia': 0,
          'Avalanche Fuji': 1,
          'OP Sepolia': 2,
          'Arbitrum Sepolia': 3,
          'Solana Devnet': 5,
          'Base Sepolia': 6,
          'Polygon Amoy': 7,
          'Sui Testnet': 8,
          'Aptos Testnet': 9,
          'Unichain Sepolia': 10,
          'Linea Sepolia': 11,
          'Starknet Sepolia': 25,
          'Arc Testnet': 26,
          'Stellar Testnet': 27,
        }
    for (const [name, domain] of Object.entries(expected)) {
      expect(getChainByDomain(domain, mode)?.name).toBe(name)
    }
  })

  it('has a valid USDC address for every chain type', () => {
    for (const chain of chains) {
      switch (chain.chain_type) {
        case 'evm':
          expect(chain.usdc_address).toMatch(EVM_ADDRESS)
          break
        case 'aptos':
          expect(chain.usdc_address).toMatch(HEX_32)
          break
        case 'sui':
          expect(chain.usdc_address).toMatch(/^0x[0-9a-fA-F]{64}::usdc::USDC$/)
          break
        case 'starknet':
          expect(chain.usdc_address).toMatch(STARKNET_ADDRESS)
          break
        case 'solana':
          expect(chain.usdc_address).toMatch(BASE58)
          break
        case 'stellar':
          expect(chain.usdc_address).toMatch(/^USDC:G[A-Z2-7]{55}$/)
          expect(chain.usdc_sac).toMatch(STELLAR_CONTRACT)
          break
        default:
          throw new Error(`Unhandled chain type: ${chain.chain_type}`)
      }
    }
  })

  it('declares USDC decimals per chain (6 everywhere except BNB)', () => {
    for (const chain of chains) {
      const decimals = chain.usdc_decimals ?? 6
      expect([6, 18], chain.name).toContain(decimals)
    }
  })

  if (mode === 'mainnet') {
    it('uses 18 decimals for BNB Smart Chain USDC', () => {
      expect(getChainByDomain(17, 'mainnet')?.usdc_decimals).toBe(18)
    })
  }

  it('resolves CCTP contracts for every declared version', () => {
    for (const chain of chains) {
      const pattern = cctpAddressPattern(chain.chain_type)
      for (const version of chain.cctp_versions ?? []) {
        const contracts = getCctpContracts(chain.domain, version, mode)
        expect(contracts, `${mode}/${chain.name} v${version}`).not.toBeNull()
        expect(contracts!.tokenMessenger).toMatch(pattern)
        expect(contracts!.messageTransmitter).toMatch(pattern)
      }
    }
  })

  it('only offers fast transfer on chains that support CCTP v2', () => {
    for (const chain of chains) {
      if (chain.supports_fast_transfer) {
        expect(chain.cctp_versions ?? [], chain.name).toContain(2)
      }
      const types = getTransferTypes(chain.domain, chain.domain, mode)
      expect(types).toContain('standard')
      expect(types).not.toContain('forward')
      expect(types.includes('fast')).toBe(chain.supports_fast_transfer)
    }
  })

  it('uses HTTPS RPC endpoints', () => {
    for (const chain of chains) {
      expect(chain.rpc_url, chain.name).toMatch(/^https:\/\//)
    }
  })
})

describe('attestation URLs', () => {
  it('uses the versioned path for CCTP v2', () => {
    expect(getAttestationUrl(2, 'testnet')).toMatch(/\/v2$/)
    expect(getAttestationUrl(2, 'mainnet')).toMatch(/\/v2$/)
  })

  it('uses the base path for CCTP v1', () => {
    expect(getAttestationUrl(1, 'testnet')).not.toMatch(/\/v2$/)
    expect(getAttestationUrl(1, 'mainnet')).not.toMatch(/\/v2$/)
  })
})

describe('chain lookup helpers', () => {
  it('returns undefined for unknown domains', () => {
    expect(getChainByDomain(9999, 'mainnet')).toBeUndefined()
  })

  it('parses the network mode from a path', () => {
    expect(modeFromPath('/mainnet')).toBe('mainnet')
    expect(modeFromPath('/mainnet/tx/0xabc')).toBe('mainnet')
    expect(modeFromPath('/')).toBe('testnet')
    expect(modeFromPath('/tx/0xabc')).toBe('testnet')
  })

  it('prefixes mainnet routes only', () => {
    expect(withModePrefix('mainnet', '/')).toBe('/mainnet')
    expect(withModePrefix('mainnet', '/tx/0xabc')).toBe('/mainnet/tx/0xabc')
    expect(withModePrefix('testnet', '/tx/0xabc')).toBe('/tx/0xabc')
  })
})
