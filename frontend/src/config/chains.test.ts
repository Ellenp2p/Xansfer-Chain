import { describe, expect, it } from 'vitest'
import configJson from '../../../config/chains.json'
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

describe('Aptos CCTP v2 deployment', () => {
  const expected = {
    mainnet: {
      tokenMessenger: '0x551e32781793c30bf1580d11e4f5171e8d068c3d45c3a5b20ae240bfdad99af8',
      messageTransmitter: '0x1b3f6d749cb835451202f9a1932e49014266f7e3d51611a9a763d156cb4bdaf6',
      cctpExtensions: '0x93c742af9a876b10c8e13584fb443597611f0efdb342530aa0ebc5ad208815ff',
      stablecoinHandler: '0x2b963f8aa28b815d2e875bd85a1a01d5f2d346f08f5b9fcf8953c77680735af2',
      stablecoin: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
    },
    testnet: {
      tokenMessenger: '0xc601d3f7b89b77b552726d5d84cbf2a6d3e8a73adbbee3f09fad169a3286bb59',
      messageTransmitter: '0xa582dc019ae17b0485f7d3fcc4ca85bea7941e3b70a4b682cea22759f36e711f',
      cctpExtensions: '0x84010f184db7b60e0067f360b6f809c16cf72ae6ea061cf15ffff2ce9b9b6963',
      stablecoinHandler: '0xe5d19c4eb6e1e42c5435901fc6153fd19f6615651be0e6cefe0f07226d4a6846',
      stablecoin: '0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832',
    },
  } as const

  for (const mode of ['mainnet', 'testnet'] as const) {
    it(`matches Circle docs on ${mode}`, () => {
      const v2 = (configJson as unknown as {
        modes: Record<string, {
          cctp: {
            v1: {
              token_messenger: Record<string, string>
              message_transmitter: Record<string, string>
            }
            v2: {
              token_messenger: Record<string, string>
              message_transmitter: Record<string, string>
              cctp_extensions?: Record<string, string>
              stablecoin_handler?: Record<string, string>
            }
          }
          chains: Array<{ domain: number; chain_type: string; usdc_address: string; cctp_versions: number[] }>
        }>
      }).modes[mode]
      const aptos = v2.chains.find((chain) => chain.chain_type === 'aptos')

      expect(aptos).toBeDefined()
      // Circle removed the Aptos V1 packages from testnet (verified on-chain),
      // so testnet is V2-only while mainnet keeps both versions.
      expect(aptos!.cctp_versions).toEqual(mode === 'mainnet' ? [1, 2] : [2])
      expect(aptos!.usdc_address).toBe(expected[mode].stablecoin)
      expect(v2.cctp.v2.token_messenger['9']).toBe(expected[mode].tokenMessenger)
      expect(v2.cctp.v2.message_transmitter['9']).toBe(expected[mode].messageTransmitter)
      expect(v2.cctp.v2.cctp_extensions?.['9']).toBe(expected[mode].cctpExtensions)
      expect(v2.cctp.v2.stablecoin_handler?.['9']).toBe(expected[mode].stablecoinHandler)

      if (mode === 'mainnet') {
        expect(v2.cctp.v1.token_messenger['9']).toBe(
          '0x9bce6734f7b63e835108e3bd8c36743d4709fe435f44791918801d0989640a9d',
        )
        expect(v2.cctp.v1.message_transmitter['9']).toBe(
          '0x177e17751820e4b4371873ca8c30279be63bdea63b88ed0f2239c2eea10f1772',
        )
      }
    })
  }
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
