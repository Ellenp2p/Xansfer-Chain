/**
 * Pure planning + guardrail logic for the cross-chain canary.
 *
 * Kept free of I/O so the safety limits are unit-tested: the executor in
 * `frontend/scripts/canary.ts` can only build a plan that passed these checks.
 */

export type CanaryMode = 'distribute' | 'collect' | 'roundtrip'

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
  amountUsdc: string
}

export interface CanaryPlanInput {
  mode: CanaryMode
  routes: string[]
  amountUsdc: string
  maxTransfers?: number
  chains: CanaryChain[]
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

function findChain(token: string, chains: CanaryChain[]): CanaryChain {
  const byDomain = /^\d+$/.test(token) ? chains.find((c) => c.domain === Number(token)) : undefined
  const found = byDomain ?? chains.find((c) => chainSlug(c.name) === token)
  if (!found) throw new CanaryGuardError(`Unknown chain "${token}"`)
  return found
}

function validateEndpoint(chain: CanaryChain, role: string): void {
  if (chain.chain_type !== 'evm') {
    throw new CanaryGuardError(`${role} ${chain.name} is not EVM (canary currently supports EVM testnets only)`)
  }
  if (!(chain.cctp_versions ?? []).includes(2)) {
    throw new CanaryGuardError(`${role} ${chain.name} does not support CCTP v2`)
  }
  if (chain.chain_id == null) {
    throw new CanaryGuardError(`${role} ${chain.name} has no chain_id configured`)
  }
}

export function parseRoute(
  input: string,
  chains: CanaryChain[],
): { from: CanaryChain; to: CanaryChain } {
  const parts = input.split('->').map((s) => s.trim()).filter(Boolean)
  if (parts.length !== 2) {
    throw new CanaryGuardError(`Invalid route "${input}" (expected e.g. base-sepolia->ethereum-sepolia)`)
  }
  const from = findChain(parts[0], chains)
  const to = findChain(parts[1], chains)
  validateEndpoint(from, 'Source')
  validateEndpoint(to, 'Destination')
  if (from.domain === to.domain) {
    throw new CanaryGuardError(`Route source and destination are the same chain (${from.name})`)
  }
  return { from, to }
}

export function buildCanaryPlan(input: CanaryPlanInput): CanaryLeg[] {
  validateAmount(input.amountUsdc)
  if (input.routes.length === 0) throw new CanaryGuardError('At least one route is required')

  const parsed = input.routes.map((route) => parseRoute(route, input.chains))

  let legs: Array<{ from: CanaryChain; to: CanaryChain }>
  if (input.mode === 'roundtrip') {
    if (parsed.length !== 1) throw new CanaryGuardError('roundtrip mode takes exactly one route')
    legs = [parsed[0], { from: parsed[0].to, to: parsed[0].from }]
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
    amountUsdc: input.amountUsdc.trim(),
  }))
}
