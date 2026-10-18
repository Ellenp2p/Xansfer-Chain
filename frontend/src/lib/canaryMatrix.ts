/**
 * Route matrix for the config-driven CCTP canary.
 *
 * Enumerates every directed testnet route that is both configured and backed by
 * an implemented chain driver, then shards it so a full sweep can be spread
 * across runs without exceeding per-run transfer limits.
 *
 * Pure functions only; the canary CLI reads the config and coverage file.
 */

export interface MatrixChain {
  domain: number
  name: string
  chain_type: string
  chain_id: number | null
  cctp_versions?: number[]
}

export interface MatrixRoute {
  id: string
  fromDomain: number
  toDomain: number
  version: number
  fromType: string
  toType: string
}

export interface CoverageSummary {
  total: number
  covered: number
  missing: number
  byPair: Record<string, { total: number; covered: number }>
}

export function routeId(fromDomain: number, toDomain: number, version: number): string {
  return `${fromDomain}-${toDomain}-v${version}`
}

/**
 * All directed routes between chains whose chain type has a driver and whose
 * CCTP version sets intersect. Same-chain routes are excluded.
 */
export function enumerateRoutes(chains: MatrixChain[], supportedTypes: string[]): MatrixRoute[] {
  const supported = new Set(supportedTypes)
  const routes: MatrixRoute[] = []

  for (const from of chains) {
    if (!supported.has(from.chain_type)) continue
    for (const to of chains) {
      if (from.domain === to.domain) continue
      if (!supported.has(to.chain_type)) continue

      const toVersions = new Set(to.cctp_versions ?? [2])
      for (const version of from.cctp_versions ?? [2]) {
        if (!toVersions.has(version)) continue
        routes.push({
          id: routeId(from.domain, to.domain, version),
          fromDomain: from.domain,
          toDomain: to.domain,
          version,
          fromType: from.chain_type,
          toType: to.chain_type,
        })
      }
    }
  }

  return routes.sort(
    (a, b) => a.fromDomain - b.fromDomain || a.toDomain - b.toDomain || a.version - b.version,
  )
}

/** Stable sharding: every route belongs to exactly one shard. */
export function shardRoutes(routes: MatrixRoute[], shardIndex: number, shardCount: number): MatrixRoute[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shardCount must be a positive integer (got ${shardCount})`)
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex must be between 0 and ${shardCount - 1} (got ${shardIndex})`)
  }
  return routes.filter((_, index) => index % shardCount === shardIndex)
}

/** Pick the next routes that have not been covered yet, preserving matrix order. */
export function pickUncovered(
  routes: MatrixRoute[],
  coveredIds: Iterable<string>,
  limit: number,
): MatrixRoute[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer (got ${limit})`)
  }
  const covered = new Set(coveredIds)
  const picked: MatrixRoute[] = []
  for (const route of routes) {
    if (covered.has(route.id)) continue
    picked.push(route)
    if (picked.length >= limit) break
  }
  return picked
}

export function summarizeCoverage(
  routes: MatrixRoute[],
  coveredIds: Iterable<string>,
): CoverageSummary {
  const covered = new Set(coveredIds)
  const byPair: Record<string, { total: number; covered: number }> = {}
  let coveredCount = 0

  for (const route of routes) {
    const pair = `${route.fromType}->${route.toType}`
    byPair[pair] ??= { total: 0, covered: 0 }
    byPair[pair].total += 1

    if (covered.has(route.id)) {
      coveredCount += 1
      byPair[pair].covered += 1
    }
  }

  return {
    total: routes.length,
    covered: coveredCount,
    missing: routes.length - coveredCount,
    byPair,
  }
}
