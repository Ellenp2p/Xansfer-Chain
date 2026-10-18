/**
 * Cross-chain canary: burns a tiny amount of testnet USDC through CCTP, waits
 * for Circle's attestation, claims on the destination, and asserts that the
 * destination balance increased.
 *
 * Safety model:
 *   - testnet only (mainnet chains are never loaded)
 *   - dry-run by default; real transactions require CANARY_EXECUTE=true
 *   - hard caps on amount (0.05 USDC) and transfers per run (3), enforced in
 *     the unit-tested planner (src/lib/canaryPlan.ts)
 *   - a daily counter prevents repeated local executions
 *   - transfers run sequentially; no automatic retry after a burn is sent
 *   - Circle Iris polling backs off on 429 instead of hammering the API
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { buildCanaryPlan, CanaryGuardError, parseDriverList, type CanaryMode } from '../src/lib/canaryPlan'
import { parseUsdcUnits } from '../src/lib/fees'
import { driverFor } from './canary/index'
import {
  addressEnvName,
  addressOverride,
  chainByDomain,
  envFlag,
  envNumber,
  loadTestnet,
  secretEnvName,
  secretFor,
  STATE_PATH,
  waitForAttestation,
} from './canary/core'
import type { DriverChain } from './canary/types'

function log(message: string): void {
  console.log(`[canary] ${message}`)
}

function fail(message: string, code = 1): never {
  console.error(`[canary] ERROR: ${message}`)
  process.exit(code)
}

const pollMs = envNumber('CANARY_POLL_MS', 15_000, 5_000)
const claimTimeoutMs = envNumber('CANARY_CLAIM_TIMEOUT_MS', 1_200_000, 60_000)

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function readState(): { date: string; count: number } {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { date?: string; count?: number }
    return { date: parsed.date ?? '', count: Number(parsed.count ?? 0) }
  } catch {
    return { date: '', count: 0 }
  }
}

function writeState(state: { date: string; count: number }): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

/** Wallet address for a chain type: derived from the secret, or a read-only override. */
function walletAddress(chain: DriverChain, required: boolean): string | undefined {
  const secret = secretFor(chain.chain_type)
  if (secret) return driverFor(chain.chain_type).address(secret)
  const override = addressOverride(chain.chain_type)
  if (override) return override
  if (required) {
    throw new CanaryGuardError(
      `missing ${secretEnvName(chain.chain_type)} (or ${addressEnvName(chain.chain_type)} for a read-only dry run) ` +
        `for ${chain.name}`,
    )
  }
  return undefined
}

async function preflight(
  plan: Array<{ fromDomain: number; toDomain: number; version: number; amountUsdc: string }>,
  chains: DriverChain[],
): Promise<void> {
  const outgoing = new Map<number, bigint>()
  for (const leg of plan) {
    const chain = chainByDomain(chains, leg.fromDomain)
    outgoing.set(leg.fromDomain, (outgoing.get(leg.fromDomain) ?? 0n) + parseUsdcUnits(leg.amountUsdc, chain.usdc_decimals))
  }

  const domains = new Set(plan.flatMap((leg) => [leg.fromDomain, leg.toDomain]))
  for (const domain of domains) {
    const chain = chainByDomain(chains, domain)
    const driver = driverFor(chain.chain_type)
    const address = walletAddress(chain, false)
    if (!address) {
      log(`${chain.name}: no wallet configured (${secretEnvName(chain.chain_type)}); skipping balance preflight`)
      continue
    }

    const native = await driver.nativeBalance(chain, address)
    log(`${chain.name}: native balance ${native} (${driver.nativeSymbol})`)
    if (driver.defaultMinNative > 0n && native < driver.defaultMinNative) {
      throw new CanaryGuardError(`${chain.name}: native balance below ${driver.defaultMinNative} ${driver.nativeSymbol}`)
    }

    const usdc = await driver.usdcBalance(chain, address)
    log(`${chain.name}: USDC balance ${usdc} units`)
    const planned = outgoing.get(domain) ?? 0n
    if (planned > 0n && usdc < planned) {
      throw new CanaryGuardError(`${chain.name}: USDC balance ${usdc} < planned ${planned} units`)
    }
  }
}

async function main(): Promise<void> {
  const mode = (process.env.CANARY_MODE ?? 'distribute') as CanaryMode
  if (!['distribute', 'collect', 'roundtrip'].includes(mode)) fail(`unknown CANARY_MODE "${mode}"`)

  const drivers = parseDriverList(process.env.CANARY_DRIVERS)
  const routeInput = process.env.CANARY_ROUTE ?? 'base-sepolia->ethereum-sepolia'
  const routes = routeInput.split(',').map((route) => route.trim()).filter(Boolean)
  const amountUsdc = process.env.CANARY_AMOUNT_USDC ?? '0.01'
  const execute = envFlag('CANARY_EXECUTE', false)
  const fast = envFlag('CANARY_FAST', false)
  const maxTransfers = process.env.CANARY_MAX_TRANSFERS ? Number(process.env.CANARY_MAX_TRANSFERS) : undefined
  if (maxTransfers != null && !Number.isFinite(maxTransfers)) fail('CANARY_MAX_TRANSFERS must be a number')
  const dailyLimit = Number(process.env.CANARY_DAILY_LIMIT ?? '1')
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 3) {
    fail('CANARY_DAILY_LIMIT must be an integer between 1 and 3')
  }

  const { config, chains } = loadTestnet()
  const plan = buildCanaryPlan({ mode, routes, amountUsdc, maxTransfers, chains, supportedTypes: drivers })

  log(`drivers=${drivers.join(',')} mode=${mode} execute=${execute} amount=${amountUsdc} transfers=${plan.length}`)
  for (const leg of plan) {
    const from = chainByDomain(chains, leg.fromDomain)
    const to = chainByDomain(chains, leg.toDomain)
    log(`  ${from.name} (${from.domain}) -> ${to.name} (${to.domain}) v${leg.version}`)
  }

  if (!execute) {
    log('DRY RUN: no transaction will be sent. Set CANARY_EXECUTE=true to execute.')
    try {
      await preflight(plan, chains)
    } catch (error) {
      log(`preflight skipped: ${(error as Error).message}`)
    }
    return
  }

  const state = readState()
  const today = todayUtc()
  if (state.date !== today) {
    state.date = today
    state.count = 0
  }
  if (state.count >= dailyLimit) {
    fail(`daily limit reached (${state.count}/${dailyLimit}); refusing to send more transactions today`)
  }

  await preflight(plan, chains)
  log(`executing ${plan.length} transfer(s) sequentially`)

  for (const leg of plan) {
    const from = chainByDomain(chains, leg.fromDomain)
    const to = chainByDomain(chains, leg.toDomain)
    const fromDriver = driverFor(from.chain_type)
    const toDriver = driverFor(to.chain_type)
    const fromSecret = secretFor(from.chain_type)
    const toSecret = secretFor(to.chain_type)
    if (!fromSecret) fail(`missing ${secretEnvName(from.chain_type)} for ${from.name}`)
    if (!toSecret) fail(`missing ${secretEnvName(to.chain_type)} for ${to.name}`)

    const destAddress = toDriver.address(toSecret)
    const amountUnits = parseUsdcUnits(leg.amountUsdc, from.usdc_decimals)

    const before = await toDriver.usdcBalance(to, destAddress)
    log(`${from.name} -> ${to.name}: burning ${leg.amountUsdc} USDC (v${leg.version})`)
    const burnTx = await fromDriver.burn(
      { config, log },
      { chain: from, version: leg.version, amountUnits, destDomain: to.domain, destChain: to, destAddress, fast, secret: fromSecret },
    )
    log(`burn tx: ${burnTx}`)
    if (fromDriver.waitForBurn) await fromDriver.waitForBurn(from, burnTx)

    const { message, attestation } = await waitForAttestation({
      config,
      version: leg.version,
      sourceDomain: from.domain,
      burnTx,
      timeoutMs: claimTimeoutMs,
      pollMs,
      log,
    })
    log('attestation ready; claiming on destination')

    const claimTx = await toDriver.claim(
      { config, log },
      { chain: to, version: leg.version, message, attestation, secret: toSecret },
    )
    log(`claim tx: ${claimTx}`)

    const after = await toDriver.usdcBalance(to, destAddress)
    if (after <= before) {
      fail(`${to.name}: USDC balance did not increase (${before} -> ${after})`)
    }
    log(`${to.name}: received ${after - before} USDC units`)

    state.count += 1
    writeState(state)
  }

  log('canary completed')
}

try {
  await main()
} catch (error) {
  if (error instanceof CanaryGuardError) fail(error.message, 1)
  fail((error as Error).message, 2)
}
