import type { ChainConfig } from '../types'
import { DEFAULT_CHAINS_MAINNET, DEFAULT_CHAINS_TESTNET, DEFAULT_CCTP } from './defaults'

// Static import of the shared JSON config. Vite embeds this at build time.
// If the file is missing at build time, this import fails during build —
// which is intentional: the config file should be present in production.
import configJson from '../../../config/chains.json'

export type Mode = 'mainnet' | 'testnet'

interface ResolvableStringValue {
  env?: string
  template?: string
}

type ResolvableString = string | ResolvableStringValue

function resolveString(value: ResolvableString): string {
  if (typeof value === 'string') return value

  if ('env' in value && value.env) {
    const envKey = value.env
    const envValue = import.meta.env[envKey]
    if (!envValue) {
      console.warn(`[config] Environment variable ${envKey} is not set`)
      return ''
    }
    return String(envValue)
  }

  if ('template' in value && value.template) {
    return value.template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, varName) => {
      const viteVarName = varName.startsWith('VITE_') ? varName : `VITE_${varName}`
      const envValue = import.meta.env[viteVarName]
      if (!envValue) {
        console.warn(`[config] Environment variable ${viteVarName} is not set for template`)
        return ''
      }
      return String(envValue)
    })
  }

  return ''
}

function resolveChainConfig(raw: any): ChainConfig {
  return {
    domain: raw.domain,
    name: raw.name,
    chain_id: raw.chain_id ?? null,
    rpc_url: resolveString(raw.rpc_url),
    explorer_url: resolveString(raw.explorer_url),
    usdc_address: resolveString(raw.usdc_address),
    usdc_sac: raw.usdc_sac ? resolveString(raw.usdc_sac) : undefined,
    cctp_versions: raw.cctp_versions ?? [2],
    chain_type: raw.chain_type,
    supports_fast_transfer: raw.supports_fast_transfer ?? false,
    supports_forwarding: raw.supports_forwarding ?? false,
    block_time_ms: raw.block_time_ms ?? 2000,
    finality_blocks: raw.finality_blocks ?? 1,
  }
}

function isValidConfig(value: unknown): value is { version: number; modes: Record<string, { chains: unknown[]; cctp: unknown }> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof (value as any).version === 'number' &&
    'modes' in value &&
    typeof (value as any).modes === 'object' &&
    (value as any).modes !== null
  )
}

function getChainsForMode(mode: Mode): ChainConfig[] {
  if (!isValidConfig(configJson)) {
    console.warn('[config] config/chains.json is invalid, using defaults')
    return mode === 'mainnet' ? DEFAULT_CHAINS_MAINNET : DEFAULT_CHAINS_TESTNET
  }

  const modeConfig = (configJson as any).modes[mode]
  if (!modeConfig || !Array.isArray(modeConfig.chains) || modeConfig.chains.length === 0) {
    console.warn(`[config] No chains defined for ${mode}, using defaults`)
    return mode === 'mainnet' ? DEFAULT_CHAINS_MAINNET : DEFAULT_CHAINS_TESTNET
  }

  return modeConfig.chains.map(resolveChainConfig)
}

function getCctpForMode(mode: Mode) {
  if (!isValidConfig(configJson)) {
    return DEFAULT_CCTP[mode]
  }

  const modeConfig = (configJson as any).modes[mode]
  if (!modeConfig || !modeConfig.cctp) {
    return DEFAULT_CCTP[mode]
  }

  return modeConfig.cctp
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getChains(mode: Mode): ChainConfig[] {
  return getChainsForMode(mode)
}

export const CHAINS = DEFAULT_CHAINS_MAINNET

export function getChainByDomain(domain: number, mode: Mode = 'mainnet'): ChainConfig | undefined {
  return getChains(mode).find((c) => c.domain === domain)
}

export function getTransferTypes(sourceDomain: number, destDomain: number, mode: Mode = 'mainnet'): string[] {
  const src = getChainByDomain(sourceDomain, mode)
  const dst = getChainByDomain(destDomain, mode)
  if (!src || !dst) return []

  const types: string[] = ['standard']
  if (src.supports_fast_transfer) types.push('fast')
  if (src.supports_forwarding && dst.supports_forwarding) types.push('forward')
  types.push('relay')
  return types
}

export function getChainTypeForDomain(domain: number, mode: Mode = 'mainnet'): string | null {
  return getChainByDomain(domain, mode)?.chain_type ?? null
}

export function getSupportedVersions(domain: number, mode: Mode = 'mainnet'): number[] {
  return getChainByDomain(domain, mode)?.cctp_versions ?? [2]
}

// ── CCTP config helpers ─────────────────────────────────────────────────────

export function getCctpContracts(domain: number, version: number, mode: Mode) {
  const cctp = getCctpForMode(mode)
  if (version === 2) {
    const domainKey = String(domain)
    const tokenMessenger = cctp.v2.token_messenger_domains?.[domainKey]
      ?? cctp.v2.token_messenger
    const messageTransmitter = cctp.v2.message_transmitter_domains?.[domainKey]
      ?? cctp.v2.message_transmitter
    return {
      tokenMessenger: resolveString(tokenMessenger),
      messageTransmitter: resolveString(messageTransmitter),
    }
  }
  if (version === 1 && cctp.v1) {
    const tm = cctp.v1.token_messenger[domain]
    const mt = cctp.v1.message_transmitter[domain]
    if (!tm || !mt) return null
    return {
      tokenMessenger: resolveString(tm),
      messageTransmitter: resolveString(mt),
    }
  }
  return null
}

export function getAttestationUrl(version: number, mode: Mode): string {
  const cctp = getCctpForMode(mode)
  const base = version === 2 ? resolveString(cctp.v2.attestation_api) : resolveString(cctp.v1?.attestation_api ?? cctp.v2.attestation_api)
  return version === 2 ? `${base}/v2` : base
}

// Re-export wagmi chain objects for external consumers
import {
  mainnet, avalanche, optimism, arbitrum, base, polygon, linea, sonic,
  sepolia, optimismSepolia, arbitrumSepolia, baseSepolia, polygonAmoy,
  avalancheFuji,
} from 'wagmi/chains'

export const TESTNET_WAGMI_CHAINS = [
  sepolia, avalancheFuji, optimismSepolia, arbitrumSepolia, baseSepolia, polygonAmoy, linea, sonic,
]

export const MAINNET_WAGMI_CHAINS = [
  mainnet, avalanche, optimism, arbitrum, base, polygon, linea, sonic,
]
