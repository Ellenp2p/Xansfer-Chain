/**
 * Config loading + shared I/O for the headless canary.
 *
 * The executor mounts `config/chains.json` (testnet only), resolves any
 * env/template indirections, and exposes the result to the drivers. Chain
 * secrets are read from `CANARY_<TYPE>_PRIVATE_KEY` / `CANARY_<TYPE>_SECRET`;
 * read-only addresses can be supplied with `CANARY_<TYPE>_ADDRESS` for dry runs.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CctpVersionConfig, DriverChain, Mode, TestnetConfig } from './types'

const here = dirname(fileURLToPath(import.meta.url))
export const CONFIG_PATH = resolve(here, '../../../config/chains.json')
export const STATE_PATH = resolve(here, '../../.canary-state.json')

type Resolvable = string | { env?: string; template?: string } | undefined

function resolveString(value: Resolvable, label: string): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (value.env) {
      const resolved = process.env[value.env]
      if (!resolved) throw new Error(`missing environment variable ${value.env} for ${label}`)
      return resolved
    }
    if (value.template) {
      return value.template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
        const viteName = name.startsWith('VITE_') ? name : `VITE_${name}`
        const resolved = process.env[viteName]
        if (!resolved) throw new Error(`missing environment variable ${viteName} for ${label}`)
        return resolved
      })
    }
  }
  throw new Error(`cannot resolve ${label}`)
}

function resolveMap(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, Resolvable>)) {
    out[key] = resolveString(entry, `${label}[${key}]`)
  }
  return out
}

function resolveVersion(raw: Record<string, unknown>, label: string): CctpVersionConfig {
  return {
    token_messenger: resolveMap(raw.token_messenger, `${label}.token_messenger`),
    message_transmitter: resolveMap(raw.message_transmitter, `${label}.message_transmitter`),
    attestation_api: resolveString(raw.attestation_api as Resolvable, `${label}.attestation_api`),
    cctp_extensions: raw.cctp_extensions
      ? resolveMap(raw.cctp_extensions, `${label}.cctp_extensions`)
      : undefined,
    stablecoin_handler: raw.stablecoin_handler
      ? resolveMap(raw.stablecoin_handler, `${label}.stablecoin_handler`)
      : undefined,
  }
}

export interface LoadedTestnet {
  config: TestnetConfig
  chains: DriverChain[]
}

export function loadTestnet(path = CONFIG_PATH): LoadedTestnet {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    modes: {
      testnet: {
        chains: Array<Record<string, unknown>>
        cctp: { v1?: Record<string, unknown>; v2: Record<string, unknown> }
      }
    }
  }
  const testnet = raw.modes.testnet
  if (!testnet) throw new Error('config/chains.json has no testnet mode')

  const chains: DriverChain[] = testnet.chains.map((entry) => ({
    domain: Number(entry.domain),
    name: String(entry.name),
    chain_type: String(entry.chain_type),
    chain_id: entry.chain_id == null ? null : Number(entry.chain_id),
    cctp_versions: (entry.cctp_versions as number[] | undefined) ?? [2],
    usdc_decimals: Number(entry.usdc_decimals ?? 6),
    rpc_url: resolveString(entry.rpc_url as Resolvable, `${String(entry.name)}.rpc_url`),
    usdc_address: resolveString(entry.usdc_address as Resolvable, `${String(entry.name)}.usdc_address`),
    usdc_sac: entry.usdc_sac
      ? resolveString(entry.usdc_sac as Resolvable, `${String(entry.name)}.usdc_sac`)
      : undefined,
  }))

  const v2 = resolveVersion(testnet.cctp.v2, 'testnet.cctp.v2')
  const v1 = testnet.cctp.v1
    ? resolveVersion(testnet.cctp.v1, 'testnet.cctp.v1')
    : { ...v2 }

  return { config: { mode: 'testnet' as Mode, v1, v2 }, chains }
}

export function chainByDomain(chains: DriverChain[], domain: number): DriverChain {
  const chain = chains.find((c) => c.domain === domain)
  if (!chain) throw new Error(`no testnet chain configured for domain ${domain}`)
  return chain
}

export function contractsFor(
  ctx: { config: TestnetConfig },
  version: number,
  domain: number,
): { tokenMessenger: string; messageTransmitter: string } {
  const cfg = version === 1 ? ctx.config.v1 : ctx.config.v2
  const tokenMessenger = cfg.token_messenger[String(domain)]
  const messageTransmitter = cfg.message_transmitter[String(domain)]
  if (!tokenMessenger || !messageTransmitter) {
    throw new Error(`no CCTP v${version} contracts configured for domain ${domain}`)
  }
  return { tokenMessenger, messageTransmitter }
}

const SECRET_ENV: Record<string, string[]> = {
  evm: ['CANARY_EVM_PRIVATE_KEY'],
  aptos: ['CANARY_APTOS_PRIVATE_KEY'],
  sui: ['CANARY_SUI_PRIVATE_KEY'],
  stellar: ['CANARY_STELLAR_SECRET', 'CANARY_STELLAR_PRIVATE_KEY'],
  solana: ['CANARY_SOLANA_PRIVATE_KEY', 'CANARY_SOLANA_SECRET'],
  starknet: ['CANARY_STARKNET_PRIVATE_KEY'],
}

const ADDRESS_ENV: Record<string, string[]> = {
  evm: ['CANARY_EVM_ADDRESS'],
  aptos: ['CANARY_APTOS_ADDRESS'],
  sui: ['CANARY_SUI_ADDRESS'],
  stellar: ['CANARY_STELLAR_ADDRESS'],
  solana: ['CANARY_SOLANA_ADDRESS'],
  starknet: ['CANARY_STARKNET_ADDRESS'],
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

export function secretFor(chainType: string): string | undefined {
  return firstEnv(SECRET_ENV[chainType] ?? [])
}

export function addressOverride(chainType: string): string | undefined {
  return firstEnv(ADDRESS_ENV[chainType] ?? [])
}

export function secretEnvName(chainType: string): string {
  return (SECRET_ENV[chainType] ?? [`CANARY_${chainType.toUpperCase()}_PRIVATE_KEY`])[0]
}

export function addressEnvName(chainType: string): string {
  return (ADDRESS_ENV[chainType] ?? [`CANARY_${chainType.toUpperCase()}_ADDRESS`])[0]
}

export function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function envNumber(name: string, fallback: number, minimum: number): number {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return await res.json() as T
}

export interface Attestation {
  message: string
  attestation: string
}

/**
 * Poll Circle Iris for an attestation.
 *
 * v2: GET {base}/v2/messages/{sourceDomain}?transactionHash={tx}
 * v1: GET {base}/attestations/{tx}
 *
 * 429 responses back off and retry; a burn is never retried after this point.
 */
export async function waitForAttestation(opts: {
  config: TestnetConfig
  version: number
  sourceDomain: number
  burnTx: string
  timeoutMs: number
  pollMs: number
  log: (message: string) => void
}): Promise<Attestation> {
  const base = (opts.version === 1 ? opts.config.v1 : opts.config.v2).attestation_api
  const url = opts.version === 1
    ? `${base}/attestations/${opts.burnTx}`
    : `${base}/v2/messages/${opts.sourceDomain}?transactionHash=${opts.burnTx}`
  const deadline = Date.now() + opts.timeoutMs
  opts.log(`waiting for v${opts.version} attestation: ${url}`)

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'xansfer-canary' },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 429) {
        opts.log('Iris rate limited (429); backing off 30s')
        await sleep(30_000)
        continue
      }
      if (res.ok) {
        const data = await res.json() as {
          message?: string
          attestation?: string
          status?: string
          messages?: Array<{ message?: string; attestation?: string; status?: string }>
        }
        const entry = opts.version === 1
          ? { message: data.message, attestation: data.attestation, status: data.status }
          : data.messages?.[0]
        if (
          entry?.message &&
          entry.attestation &&
          entry.attestation !== 'PENDING' &&
          entry.status !== 'pending_confirmations'
        ) {
          return { message: entry.message, attestation: entry.attestation }
        }
        if (entry?.status) opts.log(`attestation status: ${entry.status}`)
      }
    } catch (error) {
      opts.log(`Iris poll failed: ${(error as Error).message}`)
    }
    await sleep(opts.pollMs)
  }

  throw new Error(`attestation timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
}
