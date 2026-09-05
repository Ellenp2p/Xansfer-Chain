import type { Chain } from 'viem'
import {
  mainnet, avalanche, optimism, arbitrum, base, polygon, linea, sonic,
  worldchain, sei, bsc, hyperEvm, ink, plumeMainnet, morph, xdc,
  sepolia, optimismSepolia, arbitrumSepolia, baseSepolia, polygonAmoy, avalancheFuji,
} from 'wagmi/chains'
import type { ChainType } from '../types'
import { getChains, getChainByDomain } from './chains'

// ── Additional EVM chains not in wagmi/chains but supported by Xansfer ──────

function makeCustomChain(domain: number, mode: 'mainnet' | 'testnet'): Chain | null {
  const chain = getChainByDomain(domain, mode)
  if (!chain || !chain.chain_id) return null

  return {
    id: chain.chain_id,
    name: chain.name,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.rpc_url] } },
    blockExplorers: { default: { name: chain.name, url: chain.explorer_url } },
    testnet: mode === 'testnet',
  } as Chain
}

const cronos = makeCustomChain(32, 'mainnet')!
const cronosTestnet = makeCustomChain(32, 'testnet')!
const unichain = makeCustomChain(10, 'mainnet')!
const unichainSepolia = makeCustomChain(10, 'testnet')!
const lineaSepolia = makeCustomChain(11, 'testnet')!
const sonicTestnet = makeCustomChain(13, 'testnet')!
const arcTestnet = makeCustomChain(26, 'testnet')!

// Built from config: viem's own definitions for these networks carry different
// chain IDs than chains.json (and EDGE has none), so config stays authoritative.
const codex = makeCustomChain(12, 'mainnet')!
const monad = makeCustomChain(15, 'mainnet')!
const injective = makeCustomChain(29, 'mainnet')!
const edge = makeCustomChain(28, 'mainnet')!
const pharos = makeCustomChain(31, 'mainnet')!

const bnbTestnet: Chain = {
  id: 97,
  name: 'BNB Smart Chain Testnet',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://data-seed-prebsc-1-s1.binance.org:8545'] } },
  blockExplorers: { default: { name: 'BscScan Testnet', url: 'https://testnet.bscscan.com' } },
  testnet: true,
}

export const MAINNET_WAGMI_CHAINS: Chain[] = [
  mainnet, avalanche, optimism, arbitrum, base, polygon, linea, sonic,
  cronos, unichain,
  worldchain, sei, bsc, hyperEvm, ink, plumeMainnet, morph, xdc,
  codex, monad, injective, edge, pharos,
]

export const TESTNET_WAGMI_CHAINS: Chain[] = [
  sepolia, avalancheFuji, optimismSepolia, arbitrumSepolia, baseSepolia, polygonAmoy,
  lineaSepolia, sonicTestnet,
  cronosTestnet, bnbTestnet, unichainSepolia, arcTestnet,
]

// ── Mode-aware Domain <-> Chain ID mappings ─────────────────────────────────

function buildDomainMappings(mode: 'mainnet' | 'testnet') {
  const chains = getChains(mode)
  const wagmiChainIds = mode === 'testnet'
    ? new Set(TESTNET_WAGMI_CHAINS.map((c) => c.id))
    : new Set(MAINNET_WAGMI_CHAINS.map((c) => c.id))

  const chainIdToDomain: Record<number, number> = {}
  const domainToChainId: Record<number, number> = {}

  for (const chain of chains) {
    if (chain.chain_id == null) continue
    if (!wagmiChainIds.has(chain.chain_id)) continue

    if (!(chain.chain_id in chainIdToDomain)) {
      chainIdToDomain[chain.chain_id] = chain.domain
    }
    if (!(chain.domain in domainToChainId)) {
      domainToChainId[chain.domain] = chain.chain_id
    }
  }

  return { chainIdToDomain, domainToChainId, wagmiChainIds }
}

const mainnetMappings = buildDomainMappings('mainnet')
const testnetMappings = buildDomainMappings('testnet')

function getMappings(mode: 'mainnet' | 'testnet') {
  return mode === 'testnet' ? testnetMappings : mainnetMappings
}

export function getDomainForChainId(chainId: number, mode: 'mainnet' | 'testnet' = 'mainnet'): number | undefined {
  return getMappings(mode).chainIdToDomain[chainId]
}

export function getChainIdForDomain(domain: number, mode: 'mainnet' | 'testnet' = 'mainnet'): number | undefined {
  return getMappings(mode).domainToChainId[domain]
}

export function isChainSupportedByWagmi(domain: number, mode: 'mainnet' | 'testnet' = 'mainnet'): boolean {
  const chainId = getMappings(mode).domainToChainId[domain]
  return chainId != null && getMappings(mode).wagmiChainIds.has(chainId)
}

export function filterChainsByWalletType<T extends { chain_type: ChainType }>(
  chains: T[],
  walletType: ChainType | null,
): T[] {
  if (!walletType) return chains
  if (walletType === 'evm') return chains.filter((c) => c.chain_type === 'evm')
  return chains.filter((c) => c.chain_type === walletType)
}
