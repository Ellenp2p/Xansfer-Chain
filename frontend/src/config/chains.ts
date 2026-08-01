import type { ChainConfig } from '../types'

// Single source of truth: config/chains.json (committed to the repo).
// Vite embeds this at build time, so the app is fully self-contained
// and does not require the backend to resolve chain data.
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
    return String(import.meta.env[value.env] ?? '')
  }

  if ('template' in value && value.template) {
    return value.template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, varName: string) => {
      const viteVarName = varName.startsWith('VITE_') ? varName : `VITE_${varName}`
      return String(import.meta.env[viteVarName] ?? '')
    })
  }

  return ''
}

interface RawChainConfig {
  domain: number
  name: string
  chain_id: number | null
  rpc_url: ResolvableString
  explorer_url: ResolvableString
  usdc_address: ResolvableString
  usdc_sac?: ResolvableString
  token_messenger_v2: ResolvableString
  message_transmitter_v2: ResolvableString
  token_messenger_v1?: ResolvableString
  message_transmitter_v1?: ResolvableString
  cctp_versions?: number[]
  chain_type: ChainConfig['chain_type']
  supports_fast_transfer?: boolean
  supports_forwarding?: boolean
  block_time_ms?: number
  finality_blocks?: number
}

function resolveChainConfig(raw: RawChainConfig): ChainConfig {
  return {
    domain: raw.domain,
    name: raw.name,
    chain_id: raw.chain_id ?? null,
    rpc_url: resolveString(raw.rpc_url),
    explorer_url: resolveString(raw.explorer_url),
    usdc_address: resolveString(raw.usdc_address),
    usdc_sac: raw.usdc_sac ? resolveString(raw.usdc_sac) : undefined,
    token_messenger_v2: resolveString(raw.token_messenger_v2),
    message_transmitter_v2: resolveString(raw.message_transmitter_v2),
    token_messenger_v1: raw.token_messenger_v1 ? resolveString(raw.token_messenger_v1) : undefined,
    message_transmitter_v1: raw.message_transmitter_v1 ? resolveString(raw.message_transmitter_v1) : undefined,
    cctp_versions: raw.cctp_versions ?? [2],
    chain_type: raw.chain_type,
    supports_fast_transfer: raw.supports_fast_transfer ?? false,
    supports_forwarding: raw.supports_forwarding ?? false,
    block_time_ms: raw.block_time_ms ?? 2000,
    finality_blocks: raw.finality_blocks ?? 1,
  }
}

function modeConfig(mode: Mode) {
  const mc = configJson.modes[mode]
  if (!mc || !Array.isArray(mc.chains) || mc.chains.length === 0) {
    throw new Error(`[config] chains.json has no chains for mode "${mode}"`)
  }
  return mc
}

// ── Chain resolution ────────────────────────────────────────────────────────

export function getChains(mode: Mode): ChainConfig[] {
  return modeConfig(mode).chains.map((raw) => resolveChainConfig(raw as RawChainConfig))
}

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
  return types
}

export function getChainTypeForDomain(domain: number, mode: Mode = 'mainnet'): string | null {
  return getChainByDomain(domain, mode)?.chain_type ?? null
}

export function getSupportedVersions(domain: number, mode: Mode = 'mainnet'): number[] {
  return getChainByDomain(domain, mode)?.cctp_versions ?? [2]
}

// ── CCTP contract / attestation helpers ─────────────────────────────────────

export interface CctpContractSet {
  tokenMessenger: string
  messageTransmitter: string
}

export function getCctpContracts(domain: number, version: number, mode: Mode): CctpContractSet | null {
  const cctp = modeConfig(mode).cctp
  if (version === 2) {
    return {
      tokenMessenger: resolveString(cctp.v2.token_messenger),
      messageTransmitter: resolveString(cctp.v2.message_transmitter),
    }
  }
  if (version === 1 && cctp.v1) {
    const v1Tokens = cctp.v1.token_messenger as unknown as Record<string, ResolvableString>
    const v1Transmitters = cctp.v1.message_transmitter as unknown as Record<string, ResolvableString>
    const tm = v1Tokens[String(domain)]
    const mt = v1Transmitters[String(domain)]
    if (!tm || !mt) return null
    return {
      tokenMessenger: resolveString(tm),
      messageTransmitter: resolveString(mt),
    }
  }
  return null
}

export function getAttestationUrl(version: number, mode: Mode): string {
  const cctp = modeConfig(mode).cctp
  const base = version === 2
    ? resolveString(cctp.v2.attestation_api)
    : resolveString(cctp.v1?.attestation_api ?? cctp.v2.attestation_api)
  return version === 2 ? `${base}/v2` : base
}
