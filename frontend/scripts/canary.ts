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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Chain,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { TOKEN_MESSENGER_V2_ABI, MESSAGE_TRANSMITTER_V2_ABI } from '../src/config/cctp-abi'
import { fetchCircleMaxFee, parseUsdcUnits } from '../src/lib/fees'
import { normalizeMintRecipient } from '../src/lib/cctpEncoding'
import {
  buildCanaryPlan,
  CanaryGuardError,
  type CanaryChain,
  type CanaryLeg,
  type CanaryMode,
} from '../src/lib/canaryPlan'

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = resolve(here, '../../config/chains.json')
const STATE_PATH = resolve(here, '../.canary-state.json')

const ERC20_CANARY_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

interface ResolvedChain extends CanaryChain {
  rpc_url: string
  usdc_address: string
  usdc_decimals: number
}

interface AttemptSummary {
  leg: CanaryLeg
  burnTx: Hex
  claimTx: Hex
  received: bigint
  scale: number
}

function log(message: string): void {
  console.log(`[canary] ${message}`)
}

function fail(message: string, code = 1): never {
  console.error(`[canary] ERROR: ${message}`)
  process.exit(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function envNumber(name: string, fallback: number, minimum: number): number {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

const pollMs = envNumber('CANARY_POLL_MS', 15_000, 5_000)
const claimTimeoutMs = envNumber('CANARY_CLAIM_TIMEOUT_MS', 1_200_000, 60_000)

function resolveString(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const candidate = value as { env?: string; template?: string }
    if (candidate.env) {
      const resolved = process.env[candidate.env]
      if (!resolved) throw new Error(`missing environment variable ${candidate.env} for ${label}`)
      return resolved
    }
    if (candidate.template) {
      return candidate.template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
        const viteName = name.startsWith('VITE_') ? name : `VITE_${name}`
        const resolved = process.env[viteName]
        if (!resolved) throw new Error(`missing environment variable ${viteName} for ${label}`)
        return resolved
      })
    }
  }
  throw new Error(`cannot resolve ${label}`)
}

const rawConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  modes: {
    testnet: {
      chains: Array<Record<string, unknown>>
      cctp: {
        v2: {
          token_messenger: Record<string, unknown>
          message_transmitter: Record<string, unknown>
          attestation_api: unknown
        }
      }
    }
  }
}

const testnet = rawConfig.modes.testnet
const chains: ResolvedChain[] = testnet.chains.map((raw) => ({
  domain: Number(raw.domain),
  name: String(raw.name),
  chain_type: String(raw.chain_type),
  chain_id: raw.chain_id == null ? null : Number(raw.chain_id),
  cctp_versions: (raw.cctp_versions as number[] | undefined) ?? [2],
  usdc_decimals: Number(raw.usdc_decimals ?? 6),
  rpc_url: resolveString(raw.rpc_url, `${String(raw.name)}.rpc_url`),
  usdc_address: resolveString(raw.usdc_address, `${String(raw.name)}.usdc_address`),
}))

const cctpV2 = testnet.cctp.v2
const ATTESTATION_API = resolveString(cctpV2.attestation_api, 'testnet.cctp.v2.attestation_api')

function chainByDomain(domain: number): ResolvedChain {
  const chain = chains.find((c) => c.domain === domain)
  if (!chain) throw new Error(`no testnet chain configured for domain ${domain}`)
  return chain
}

function tokenMessenger(domain: number): Address {
  return resolveString(cctpV2.token_messenger[String(domain)], `v2 token_messenger[${domain}]`) as Address
}

function messageTransmitter(domain: number): Address {
  return resolveString(cctpV2.message_transmitter[String(domain)], `v2 message_transmitter[${domain}]`) as Address
}

function toViemChain(chain: ResolvedChain): Chain {
  if (chain.chain_id == null) throw new Error(`${chain.name} has no chain_id`)
  return {
    id: chain.chain_id,
    name: chain.name,
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [chain.rpc_url] } },
  } as Chain
}

function publicClientFor(chain: ResolvedChain) {
  return createPublicClient({ chain: toViemChain(chain), transport: http(chain.rpc_url) })
}

function walletClientFor(chain: ResolvedChain, account: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({ account, chain: toViemChain(chain), transport: http(chain.rpc_url) })
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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

async function waitForAttestation(sourceDomain: number, burnTx: Hex): Promise<{ message: Hex; attestation: Hex }> {
  const url = `${ATTESTATION_API}/v2/messages/${sourceDomain}?transactionHash=${burnTx}`
  const deadline = Date.now() + claimTimeoutMs
  log(`waiting for attestation: ${url}`)

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'xansfer-canary' },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 429) {
        log('Iris rate limited (429); backing off 30s')
        await sleep(30_000)
        continue
      }
      if (res.ok) {
        const data = await res.json() as {
          messages?: Array<{ message?: string; attestation?: string; status?: string }>
        }
        const message = data.messages?.[0]
        if (
          message?.message &&
          message.attestation &&
          message.attestation !== 'PENDING'
        ) {
          return { message: message.message as Hex, attestation: message.attestation as Hex }
        }
        if (message?.status) log(`attestation status: ${message.status}`)
      }
    } catch (error) {
      log(`Iris poll failed: ${(error as Error).message}`)
    }
    await sleep(pollMs)
  }

  throw new Error(`attestation timed out after ${Math.round(claimTimeoutMs / 1000)}s`)
}

async function preflight(plan: CanaryLeg[], address: Address): Promise<void> {
  const sourceDomains = new Set(plan.map((leg) => leg.fromDomain))
  const allDomains = new Set(plan.flatMap((leg) => [leg.fromDomain, leg.toDomain]))
  const minNative = parseEther(process.env.CANARY_MIN_NATIVE ?? '0.0002')

  for (const domain of allDomains) {
    const chain = chainByDomain(domain)
    const client = publicClientFor(chain)
    const chainId = await client.getChainId()
    if (chainId !== chain.chain_id) {
      throw new Error(`${chain.name}: RPC chain id ${chainId} != configured ${chain.chain_id}`)
    }
    const native = await client.getBalance({ address })
    log(`${chain.name}: native balance ${formatEther(native)}`)
    if (native < minNative) {
      throw new Error(`${chain.name}: native balance below ${formatEther(minNative)} (gas required)`)
    }
  }

  for (const domain of sourceDomains) {
    const chain = chainByDomain(domain)
    const amountUnits = plan
      .filter((leg) => leg.fromDomain === domain)
      .reduce((sum, leg) => sum + parseUsdcUnits(leg.amountUsdc, chain.usdc_decimals), 0n)
    const client = publicClientFor(chain)
    const balance = await client.readContract({
      address: chain.usdc_address as Address,
      abi: ERC20_CANARY_ABI,
      functionName: 'balanceOf',
      args: [address],
    })
    log(`${chain.name}: USDC balance ${formatUnits(balance, chain.usdc_decimals)}`)
    if (balance < amountUnits) {
      throw new Error(
        `${chain.name}: USDC balance ${formatUnits(balance, chain.usdc_decimals)} < planned ${formatUnits(amountUnits, chain.usdc_decimals)}`,
      )
    }
  }
}

async function executeLeg(
  leg: CanaryLeg,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<AttemptSummary> {
  const from = chainByDomain(leg.fromDomain)
  const to = chainByDomain(leg.toDomain)
  const decimals = from.usdc_decimals
  const amountUnits = parseUsdcUnits(leg.amountUsdc, decimals)
  const fast = envFlag('CANARY_FAST', true)
  const finalityThreshold = fast ? 1000 : 2000

  const maxFee = await fetchCircleMaxFee({
    mode: 'testnet',
    srcDomain: from.domain,
    destDomain: to.domain,
    finalityThreshold,
    amountUnits,
  })

  const fromPublic = publicClientFor(from)
  const fromWallet = walletClientFor(from, account)
  const tm = tokenMessenger(from.domain)
  const usdc = from.usdc_address as Address

  const allowance = await fromPublic.readContract({
    address: usdc,
    abi: ERC20_CANARY_ABI,
    functionName: 'allowance',
    args: [account.address, tm],
  })
  if (allowance < amountUnits) {
    log(`${from.name}: approving ${leg.amountUsdc} USDC to ${tm}`)
    const approveHash = await fromWallet.writeContract({
      address: usdc,
      abi: ERC20_CANARY_ABI,
      functionName: 'approve',
      args: [tm, amountUnits],
      account,
      chain: toViemChain(from),
    })
    const approveReceipt = await fromPublic.waitForTransactionReceipt({ hash: approveHash })
    if (approveReceipt.status !== 'success') throw new Error(`approve failed: ${approveHash}`)
  }

  const mintRecipient = normalizeMintRecipient(account.address)
  log(`${from.name} -> ${to.name}: burning ${leg.amountUsdc} USDC (fast=${fast}, maxFee=${formatUnits(maxFee, decimals)})`)
  const burnTx = await fromWallet.writeContract({
    address: tm,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: 'depositForBurn',
    args: [
      amountUnits,
      BigInt(to.domain),
      mintRecipient,
      usdc,
      `0x${'0'.repeat(64)}` as Hex,
      maxFee,
      finalityThreshold,
    ],
    account,
    chain: toViemChain(from),
  })
  log(`burn tx: ${burnTx}`)
  const burnReceipt = await fromPublic.waitForTransactionReceipt({ hash: burnTx })
  if (burnReceipt.status !== 'success') throw new Error(`burn reverted: ${burnTx}`)

  const { message, attestation } = await waitForAttestation(from.domain, burnTx)
  log('attestation ready; claiming on destination')

  const toPublic = publicClientFor(to)
  const toWallet = walletClientFor(to, account)
  const destUsdc = to.usdc_address as Address
  const before = await toPublic.readContract({
    address: destUsdc,
    abi: ERC20_CANARY_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })

  const claimTx = await toWallet.writeContract({
    address: messageTransmitter(to.domain),
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: 'receiveMessage',
    args: [message, attestation],
    account,
    chain: toViemChain(to),
  })
  log(`claim tx: ${claimTx}`)
  const claimReceipt = await toPublic.waitForTransactionReceipt({ hash: claimTx })
  if (claimReceipt.status !== 'success') throw new Error(`claim reverted: ${claimTx}`)

  const after = await toPublic.readContract({
    address: destUsdc,
    abi: ERC20_CANARY_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })
  const received = after - before
  if (received <= 0n) throw new Error('destination USDC balance did not increase')
  log(`${to.name}: received ${formatUnits(received, to.usdc_decimals)} USDC`)

  return { leg, burnTx, claimTx, received, scale: to.usdc_decimals }
}

async function main(): Promise<void> {
  const mode = (process.env.CANARY_MODE ?? 'distribute') as CanaryMode
  if (!['distribute', 'collect', 'roundtrip'].includes(mode)) {
    fail(`unknown CANARY_MODE "${mode}"`)
  }
  const routeInput = process.env.CANARY_ROUTE ?? 'base-sepolia->ethereum-sepolia'
  const routes = routeInput.split(',').map((route) => route.trim()).filter(Boolean)
  const amountUsdc = process.env.CANARY_AMOUNT_USDC ?? '0.01'
  const execute = envFlag('CANARY_EXECUTE', false)
  const maxTransfers = process.env.CANARY_MAX_TRANSFERS
    ? Number(process.env.CANARY_MAX_TRANSFERS)
    : undefined
  if (maxTransfers != null && !Number.isFinite(maxTransfers)) {
    fail('CANARY_MAX_TRANSFERS must be a number')
  }
  const dailyLimit = Number(process.env.CANARY_DAILY_LIMIT ?? '1')
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 3) {
    fail('CANARY_DAILY_LIMIT must be an integer between 1 and 3')
  }
  const key = process.env.CANARY_PRIVATE_KEY

  const plan = buildCanaryPlan({ mode, routes, amountUsdc, maxTransfers, chains })
  const account = key ? privateKeyToAccount(key as Hex) : null

  log(`mode=${mode} execute=${execute} amount=${amountUsdc} USDC transfers=${plan.length}`)
  for (const leg of plan) {
    const from = chainByDomain(leg.fromDomain)
    const to = chainByDomain(leg.toDomain)
    log(`  ${from.name} (${from.domain}) -> ${to.name} (${to.domain})`)
  }

  if (!execute) {
    log('DRY RUN: no transaction will be sent. Set CANARY_EXECUTE=true to execute.')
    if (account) {
      await preflight(plan, account.address)
    } else {
      log('no CANARY_PRIVATE_KEY set; skipping balance preflight')
    }
    return
  }

  if (!account) fail('CANARY_EXECUTE=true requires CANARY_PRIVATE_KEY')
  if (dailyLimit <= 0) fail('CANARY_DAILY_LIMIT must be greater than 0')

  const state = readState()
  const today = todayUtc()
  if (state.date !== today) {
    state.date = today
    state.count = 0
  }
  if (state.count >= dailyLimit) {
    fail(`daily limit reached (${state.count}/${dailyLimit}); refusing to send more transactions today`)
  }

  await preflight(plan, account.address)
  log(`executing ${plan.length} transfer(s) sequentially`)

  const summaries: AttemptSummary[] = []
  for (const leg of plan) {
    const summary = await executeLeg(leg, account)
    summaries.push(summary)
    state.count += 1
    writeState(state)
  }

  log('canary completed:')
  for (const summary of summaries) {
    log(
      `  ${summary.leg.fromDomain}->${summary.leg.toDomain} burn=${summary.burnTx} claim=${summary.claimTx} received=${formatUnits(summary.received, summary.scale)} USDC`,
    )
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof CanaryGuardError) {
    fail(error.message, 1)
  }
  fail((error as Error).message, 2)
}
