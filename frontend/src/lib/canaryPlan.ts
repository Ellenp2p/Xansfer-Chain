/**
 * Pure planning + guardrail logic for the cross-chain canary.
 *
 * Kept free of I/O so the safety limits are unit-tested: the executor in
 * `frontend/scripts/canary.ts` can only build a plan that passed these checks.
 *
 * A route is only accepted when both endpoints have a driver. The driver list is
 * explicit (never "all configured chains") so the matrix can never advertise a
 * path that no executor can actually run.
 */

export type CanaryMode = 'distribute' | 'collect' | 'roundtrip'

/** Chain types with a canary executor. Keep in sync with scripts/canary/drivers. */
export const CANARY_DRIVER_TYPES = [
  'evm',
  'aptos',
  'sui',
  'stellar',
  'solana',
  'starknet',
] as const

export type CanaryDriverType = (typeof CANARY_DRIVER_TYPES)[number]

export interface CanaryChain {
  domain: number
  name: string
  chain_type: string
  chain_id: number | null
  cctp_versions?: number[]
  usdc_decimals?: number
}

export interface CanaryLeg {
  fromDomain: number
  toDomain: number
  /** CCTP version both endpoints support; the executor uses this for burn/claim. */
  version: number
  amountUsdc: string
}

export interface CanaryPlanInput {
  mode: CanaryMode
  routes: string[]
  amountUsdc: string
  maxTransfers?: number
  chains: CanaryChain[]
  /**
   * Chain types whose driver is available. Defaults to every driver the repo
   * ships; callers that only run a subset can narrow it.
   */
  supportedTypes?: string[]
}

/** Hard caps. The executor refuses to run anything above these, regardless of env. */
export const HARD_MAX_AMOUNT_USDC = 0.05
export const HARD_MAX_TRANSFERS = 3
export const DEFAULT_MAX_TRANSFERS = 1

export class CanaryGuardError extends Error {}

/** "Base Sepolia" -> "base-sepolia" */
export function chainSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function validateAmount(amountUsdc: string): void {
  const trimmed = amountUsdc.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new CanaryGuardError(`Invalid amount "${amountUsdc}" (plain decimal with up to 6 places)`)
  }
  const value = Number(trimmed)
  if (!(value > 0)) throw new CanaryGuardError('Amount must be greater than 0')
  if (value > HARD_MAX_AMOUNT_USDC) {
    throw new CanaryGuardError(
      `Amount ${trimmed} USDC exceeds the hard cap of ${HARD_MAX_AMOUNT_USDC} USDC per transfer`,
    )
  }
}

/** Parse CANARY_DRIVERS ("evm,aptos" or "all"). Throws on unknown driver names. */
export function parseDriverList(value: string | undefined): string[] {
  if (!value || value.trim() === '' || value.trim() === 'all') return [...CANARY_DRIVER_TYPES]
  const drivers = value.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  const known = new Set<string>(CANARY_DRIVER_TYPES)
  for (const driver of drivers) {
    if (!known.has(driver)) {
      throw new CanaryGuardError(
        `Unknown canary driver "${driver}" (known: ${CANARY_DRIVER_TYPES.join(', ')})`,
      )
    }
  }
  return [...new Set(drivers)]
}

function findChain(token: string, chains: CanaryChain[]): CanaryChain {
  const byDomain = /^\d+$/.test(token) ? chains.find((c) => c.domain === Number(token)) : undefined
  const found = byDomain ?? chains.find((c) => chainSlug(c.name) === token)
  if (!found) throw new CanaryGuardError(`Unknown chain "${token}"`)
  return found
}

function validateEndpoint(chain: CanaryChain, role: string, supportedTypes: Set<string>): void {
  if (!supportedTypes.has(chain.chain_type)) {
    throw new CanaryGuardError(
      `${role} ${chain.name} is "${chain.chain_type}", which has no canary driver ` +
        `(supported: ${[...supportedTypes].sort().join(', ')})`,
    )
  }
}

/** Highest CCTP version both endpoints support. */
export function commonVersion(from: CanaryChain, to: CanaryChain): number {
  const toVersions = new Set(to.cctp_versions ?? [2])
  const shared = (from.cctp_versions ?? [2]).filter((version) => toVersions.has(version))
  if (shared.length === 0) {
    throw new CanaryGuardError(
      `${from.name} (${JSON.stringify(from.cctp_versions ?? [2])}) and ` +
        `${to.name} (${JSON.stringify(to.cctp_versions ?? [2])}) have no CCTP version in common`,
    )
  }
  return Math.max(...shared)
}

export function parseRoute(
  input: string,
  chains: CanaryChain[],
  supportedTypes: string[] = [...CANARY_DRIVER_TYPES],
): { from: CanaryChain; to: CanaryChain; version: number } {
  const parts = input.split('->').map((s) => s.trim()).filter(Boolean)
  if (parts.length !== 2) {
    throw new CanaryGuardError(`Invalid route "${input}" (expected e.g. base-sepolia->ethereum-sepolia)`)
  }
  const supported = new Set(supportedTypes)
  const from = findChain(parts[0], chains)
  const to = findChain(parts[1], chains)
  validateEndpoint(from, 'Source', supported)
  validateEndpoint(to, 'Destination', supported)
  if (from.domain === to.domain) {
    throw new CanaryGuardError(`Route source and destination are the same chain (${from.name})`)
  }
  return { from, to, version: commonVersion(from, to) }
}

export function buildCanaryPlan(input: CanaryPlanInput): CanaryLeg[] {
  validateAmount(input.amountUsdc)
  if (input.routes.length === 0) throw new CanaryGuardError('At least one route is required')

  const supportedTypes = input.supportedTypes ?? [...CANARY_DRIVER_TYPES]
  const parsed = input.routes.map((route) => parseRoute(route, input.chains, supportedTypes))

  let legs: Array<{ from: CanaryChain; to: CanaryChain; version: number }>
  if (input.mode === 'roundtrip') {
    if (parsed.length !== 1) throw new CanaryGuardError('roundtrip mode takes exactly one route')
    const forward = parsed[0]
    legs = [
      forward,
      { from: forward.to, to: forward.from, version: commonVersion(forward.to, forward.from) },
    ]
  } else if (input.mode === 'collect') {
    const dest = parsed[0].to.domain
    if (!parsed.every((p) => p.to.domain === dest)) {
      throw new CanaryGuardError('collect mode requires every route to share the same destination chain')
    }
    legs = parsed
  } else {
    legs = parsed
  }

  const maxTransfers = input.maxTransfers ?? (input.mode === 'roundtrip' ? 2 : DEFAULT_MAX_TRANSFERS)
  if (!Number.isFinite(maxTransfers) || maxTransfers < 1) {
    throw new CanaryGuardError('maxTransfers must be a positive number')
  }
  if (maxTransfers > HARD_MAX_TRANSFERS) {
    throw new CanaryGuardError(`maxTransfers ${maxTransfers} exceeds the hard cap of ${HARD_MAX_TRANSFERS}`)
  }
  if (legs.length > maxTransfers) {
    throw new CanaryGuardError(`Plan has ${legs.length} transfers but the per-run limit is ${maxTransfers}`)
  }

  return legs.map((leg) => ({
    fromDomain: leg.from.domain,
    toDomain: leg.to.domain,
    version: leg.version,
    amountUsdc: input.amountUsdc.trim(),
  }))
}
