import type { ChainConfig } from '../types'

// Single source of truth: config/chains.json (committed to the repo).
// Vite embeds this at build time, so the app is fully self-contained
// and does not require the backend to resolve chain data.
import configJson from '../../../config/chains.json'

export type Mode = 'mainnet' | 'testnet'

/** Network mode is driven by the URL path: `/mainnet` and `/mainnet/*` → mainnet, anything else → testnet. */
export function modeFromPath(pathname: string): Mode {
  return pathname === '/mainnet' || pathname.startsWith('/mainnet/') ? 'mainnet' : 'testnet'
}

/** Prefix a route path for the given network mode (mainnet lives under /mainnet). */
export function withModePrefix(mode: Mode, path: string): string {
  if (mode !== 'mainnet') return path
  return path === '/' ? '/mainnet' : `/mainnet${path}`
}

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
  // 'forward' (Circle Forwarding Service) is not wired up: the burn is identical
  // to standard and nothing auto-forwards the attestation, so offering it would
  // mislead users into thinking no manual claim is needed.
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
  if (version === 2 || version === 1) {
    const cfg = version === 2 ? cctp.v2 : cctp.v1
    if (!cfg) return null
    const tokens = cfg.token_messenger as unknown as Record<string, ResolvableString>
    const transmitters = cfg.message_transmitter as unknown as Record<string, ResolvableString>
    const tm = tokens[String(domain)]
    const mt = transmitters[String(domain)]
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
