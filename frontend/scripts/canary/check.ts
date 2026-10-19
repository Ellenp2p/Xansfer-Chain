/**
 * Read-only readiness check for the local canary campaign.
 *
 *   bun run canary:check
 *   bun run canary:check -- --json
 *
 * Derives (or reads) the wallet for every testnet chain, queries native + USDC
 * balances, checks one-time setup (Stellar trustline, Solana ATA) and prints how
 * much each chain still needs. It never sends a transaction.
 */

import { Connection, PublicKey } from '@solana/web3.js'
import { CANARY_DRIVER_TYPES, parseDriverList } from '../../src/lib/canaryPlan'
import { enumerateRoutes } from '../../src/lib/canaryMatrix'
import type { CanaryDriver } from './types'
import { driverFor } from './index'
import { addressOverride, loadTestnet, mnemonicFor, secretFor } from './core'

const DEFAULT_AMOUNT = process.env.CANARY_AMOUNT_USDC ?? '0.01'

interface ChainReport {
  domain: number
  name: string
  type: string
  address: string | null
  native: bigint | null
  nativeDecimals: number
  nativeSymbol: string
  minNative: bigint
  usdc: bigint | null
  usdcNeeded: bigint
  usdcDecimals: number
  setup: string | null
  status: 'ready' | 'no-wallet' | 'no-gas' | 'no-usdc' | 'error'
  error?: string
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

function formatUnits(units: bigint, decimals: number): string {
  const negative = units < 0n
  const value = negative ? -units : units
  const perCoin = 10n ** BigInt(decimals)
  const whole = value / perCoin
  const fraction = (value % perCoin).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function parseAmountUnits(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.trim().split('.')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

async function stellarSetup(address: string, usdcIssuer: string): Promise<string | null> {
  try {
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404) return 'account not activated (send 1 XLM)'
    if (!res.ok) return `horizon HTTP ${res.status}`
    const data = await res.json() as { balances?: Array<{ asset_code?: string; asset_issuer?: string }> }
    const hasTrustline = (data.balances ?? []).some(
      (balance) => balance.asset_code === 'USDC' && balance.asset_issuer === usdcIssuer,
    )
    return hasTrustline ? null : 'missing USDC trustline'
  } catch (error) {
    return `trustline check failed: ${(error as Error).message}`
  }
}

async function solanaSetup(rpcUrl: string, address: string, usdcMint: string): Promise<string | null> {
  try {
    const connection = new Connection(rpcUrl, { commitment: 'confirmed' })
    const owner = new PublicKey(address)
    const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgram.toBuffer(), new PublicKey(usdcMint).toBuffer()],
      ataProgram,
    )
    const info = await connection.getAccountInfo(ata)
    return info ? null : 'missing USDC account (ATA)'
  } catch (error) {
    return `ATA check failed: ${(error as Error).message}`
  }
}

async function main(): Promise<void> {
  const drivers = parseDriverList(process.env.CANARY_DRIVERS)
  const { chains } = loadTestnet()
  const routes = enumerateRoutes(chains, drivers)

  const outCount = new Map<number, number>()
  for (const route of routes) {
    outCount.set(route.fromDomain, (outCount.get(route.fromDomain) ?? 0) + 1)
  }

  if (!mnemonicFor()) {
    console.error('[canary] CANARY_MNEMONIC is not set; falling back to CANARY_<TYPE>_ADDRESS/PRIVATE_KEY only')
  }

  const reports: ChainReport[] = []
  for (const chain of chains) {
    if (!drivers.includes(chain.chain_type)) continue
    const driver: CanaryDriver = driverFor(chain.chain_type)
    const secret = secretFor(chain.chain_type)
    const address = secret ? driver.address(secret) : addressOverride(chain.chain_type)
    const usdcNeeded = BigInt(outCount.get(chain.domain) ?? 0) * parseAmountUnits(DEFAULT_AMOUNT, chain.usdc_decimals)

    const report: ChainReport = {
      domain: chain.domain,
      name: chain.name,
      type: chain.chain_type,
      address,
      native: null,
      nativeDecimals: driver.nativeDecimals,
      nativeSymbol: driver.nativeSymbol,
      minNative: driver.defaultMinNative,
      usdc: null,
      usdcNeeded,
      usdcDecimals: chain.usdc_decimals,
      setup: null,
      status: 'ready',
    }

    if (!address) {
      report.status = 'no-wallet'
      reports.push(report)
      continue
    }

    try {
      report.native = await driver.nativeBalance(chain, address)
      report.usdc = await driver.usdcBalance(chain, address)
    } catch (error) {
      report.status = 'error'
      report.error = (error as Error).message
      reports.push(report)
      continue
    }

    if (chain.chain_type === 'stellar') {
      report.setup = await stellarSetup(address, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
    } else if (chain.chain_type === 'solana') {
      report.setup = await solanaSetup(chain.rpc_url, address, chain.usdc_address)
    }

    if (report.native < driver.defaultMinNative) report.status = 'no-gas'
    else if (report.usdcNeeded > 0n && (report.usdc ?? 0n) < report.usdcNeeded) report.status = 'no-usdc'
    reports.push(report)
  }

  if (flag('--json')) {
    console.log(JSON.stringify({ amount: DEFAULT_AMOUNT, chains: reports.map((report) => ({
      ...report,
      native: report.native?.toString() ?? null,
      usdc: report.usdc?.toString() ?? null,
      minNative: report.minNative.toString(),
      usdcNeeded: report.usdcNeeded.toString(),
    })) }, null, 2))
    return
  }

  const width = Math.max(...reports.map((report) => report.name.length), 5)
  console.log(`[canary] readiness (amount ${DEFAULT_AMOUNT} USDC/route)`)
  console.log('  chain'.padEnd(width + 2) + 'native'.padEnd(22) + 'usdc'.padEnd(16) + 'need'.padEnd(12) + 'status')
  for (const report of reports) {
    const native = report.native == null ? '-' : `${formatUnits(report.native, report.nativeDecimals)} ${report.nativeSymbol}`
    const usdc = report.usdc == null ? '-' : formatUnits(report.usdc, report.usdcDecimals)
    const need = formatUnits(report.usdcNeeded, report.usdcDecimals)
    const status = report.error ? `error: ${report.error}` : report.setup ? `${report.status} (${report.setup})` : report.status
    console.log(`  ${report.name.padEnd(width)}  ${native.padEnd(20)}  ${usdc.padEnd(14)}  ${need.padEnd(10)}  ${status}`)
  }

  const byDomain = new Map(reports.map((report) => [report.domain, report]))
  const readyRoutes = routes.filter((route) => {
    const source = byDomain.get(route.fromDomain)
    const dest = byDomain.get(route.toDomain)
    return source?.status === 'ready' && dest?.status === 'ready'
  })
  console.log(`\n  routes ready: ${readyRoutes.length}/${routes.length}`)
  for (const route of readyRoutes.slice(0, 10)) {
    const source = byDomain.get(route.fromDomain)!
    const dest = byDomain.get(route.toDomain)!
    console.log(`    ${source.name} -> ${dest.name} v${route.version}`)
  }
  if (readyRoutes.length === 0) {
    console.log('    (fund native gas first; APT/SUI/XLM/SOL/STRK are cheap, EVM needs a faucet)')
  }
}

main().catch((error) => {
  console.error(`[canary] check failed: ${(error as Error).message}`)
  if ((error as Error).message.includes(`has no canary driver`)) {
    console.error(`[canary] known drivers: ${CANARY_DRIVER_TYPES.join(', ')}`)
  }
  process.exit(2)
})
