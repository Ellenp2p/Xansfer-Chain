/**
 * Print the config-driven canary route matrix.
 *
 *   bun run canary:matrix
 *   CANARY_DRIVERS=evm,aptos,sui,stellar bun run canary:matrix
 *   CANARY_SHARD=0/4 bun run canary:matrix
 *
 * This does not send transactions. It shows which routes exist for the drivers
 * that are implemented, how they are sharded, and what the coverage file says.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  enumerateRoutes,
  pickUncovered,
  shardRoutes,
  summarizeCoverage,
  type MatrixChain,
} from '../src/lib/canaryMatrix'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(resolve(here, '../../config/chains.json'), 'utf8')) as {
  modes: { testnet: { chains: Array<Record<string, unknown>> } }
}

const chains: MatrixChain[] = config.modes.testnet.chains.map((raw) => ({
  domain: Number(raw.domain),
  name: String(raw.name),
  chain_type: String(raw.chain_type),
  chain_id: raw.chain_id == null ? null : Number(raw.chain_id),
  cctp_versions: (raw.cctp_versions as number[] | undefined) ?? [2],
}))

const drivers = (process.env.CANARY_DRIVERS ?? 'evm')
  .split(',')
  .map((driver) => driver.trim())
  .filter(Boolean)

const shardArg = process.env.CANARY_SHARD ?? '0/1'
const [shardIndex, shardCount] = shardArg.split('/').map(Number)
const limit = Number(process.env.CANARY_MAX_TRANSFERS ?? '3')

const coveragePath = resolve(here, '../.canary-coverage.json')
let covered: string[] = []
if (existsSync(coveragePath)) {
  try {
    const parsed = JSON.parse(readFileSync(coveragePath, 'utf8')) as { routes?: string[] } | string[]
    covered = Array.isArray(parsed) ? parsed : parsed.routes ?? []
  } catch {
    covered = []
  }
}

const routes = enumerateRoutes(chains, drivers)
const shard = shardRoutes(routes, shardIndex, shardCount)
const next = pickUncovered(shard, covered, limit)
const summary = summarizeCoverage(routes, covered)

const output = {
  drivers,
  shard: `${shardIndex}/${shardCount}`,
  totalRoutes: summary.total,
  covered: summary.covered,
  missing: summary.missing,
  byPair: summary.byPair,
  shardRoutes: shard.length,
  next,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(output, null, 2))
} else {
  console.log(`drivers: ${drivers.join(', ')}`)
  console.log(`shard: ${shardIndex}/${shardCount} (${shard.length} routes)`)
  console.log(`coverage: ${summary.covered}/${summary.total} covered, ${summary.missing} missing`)
  console.log('by chain-type pair:')
  for (const [pair, stats] of Object.entries(summary.byPair)) {
    console.log(`  ${pair.padEnd(18)} ${stats.covered}/${stats.total}`)
  }
  console.log(`next up to ${limit} uncovered routes in this shard:`)
  for (const route of next) {
    console.log(`  ${route.id}  ${route.fromType}->${route.toType}`)
  }
  if (next.length === 0) console.log('  (none; shard fully covered)')
}
