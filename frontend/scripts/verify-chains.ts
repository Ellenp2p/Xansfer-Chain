/**
 * Read-only on-chain verification for config/chains.json.
 *
 * For every configured chain this checks that the RPC is reachable, that the
 * USDC address exists, that every declared CCTP version's TokenMessenger and
 * MessageTransmitter exist, and (where cheap) that USDC still reports 6
 * decimals. It never signs or sends a transaction.
 *
 * Usage:
 *   bun run verify:chains                     # testnet (default)
 *   bun run verify:chains -- --mode mainnet
 *   bun run verify:chains -- --mode all --type evm,solana,stellar
 *   bun run verify:chains -- --json
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rpc as stellarRpc, xdr as stellarXdr } from '@stellar/stellar-sdk'

type Mode = 'mainnet' | 'testnet'
type ChainType = 'evm' | 'solana' | 'sui' | 'aptos' | 'stellar' | 'starknet'

interface ChainConfig {
  domain: number
  name: string
  chain_id: number | null
  rpc_url: string
  usdc_address: string
  usdc_sac?: string
  cctp_versions: number[]
  chain_type: ChainType
}

interface CctpConfig {
  token_messenger: Record<string, string>
  message_transmitter: Record<string, string>
}

interface RawConfig {
  modes: Record<Mode, { chains: ChainConfig[]; cctp: Record<'v1' | 'v2', CctpConfig> }>
}

interface CheckResult {
  mode: Mode
  chain: string
  domain: number
  check: string
  ok: boolean
  detail?: string
  network?: boolean
}

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(
  readFileSync(resolve(here, '../../config/chains.json'), 'utf8'),
) as RawConfig

const args = process.argv.slice(2)
function argValue(name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx >= 0 ? args[idx + 1] : undefined
}
const allowNetworkErrors = args.includes('--allow-network-errors')
const jsonOutput = args.includes('--json')
const timeoutMs = Number(argValue('--timeout') ?? 15_000)
const concurrency = Number(argValue('--concurrency') ?? 4)
const modeArg = (argValue('--mode') ?? 'testnet') as Mode | 'all'
const typeFilter = argValue('--type')?.split(',').map((t) => t.trim()) as ChainType[] | undefined

function cctpContracts(mode: Mode, version: number, domain: number): { tm?: string; mt?: string } {
  const versionConfig = config.modes[mode].cctp[version === 1 ? 'v1' : 'v2']
  if (!versionConfig) return {}
  return {
    tm: versionConfig.token_messenger[String(domain)],
    mt: versionConfig.message_transmitter[String(domain)],
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

async function postRpc<T>(url: string, body: unknown): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(json.error.message ?? 'RPC error')
      if (json.result === undefined) throw new Error('Missing RPC result')
      return json.result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function verifyEvm(mode: Mode, chain: ChainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (check: string, ok: boolean, detail?: string, network = false) =>
    results.push({ mode, chain: chain.name, domain: chain.domain, check, ok, detail, network })

  const rpc = <T>(method: string, params: unknown[]) =>
    postRpc<T>(chain.rpc_url, { jsonrpc: '2.0', id: 1, method, params })

  try {
    const chainId = Number.parseInt(await rpc<string>('eth_chainId', []), 16)
    add('chain id', chainId === chain.chain_id, `configured ${chain.chain_id}, RPC ${chainId}`)
  } catch (error) {
    add('rpc reachable', false, (error as Error).message, true)
    return results
  }

  const code = async (address: string): Promise<string> =>
    rpc<string>('eth_getCode', [address, 'latest'])

  try {
    const usdcCode = await code(chain.usdc_address)
    add('USDC contract exists', usdcCode !== '0x', chain.usdc_address)
  } catch (error) {
    add('USDC contract exists', false, (error as Error).message, true)
  }

  try {
    const decimalsHex = await rpc<string>('eth_call', [
      { to: chain.usdc_address, data: '0x313ce567' },
      'latest',
    ])
    const decimals = Number.parseInt(decimalsHex, 16)
    add('USDC decimals = 6', decimals === 6, `got ${decimals}`)
  } catch (error) {
    add('USDC decimals = 6', false, (error as Error).message, true)
  }

  for (const version of chain.cctp_versions) {
    const { tm, mt } = cctpContracts(mode, version, chain.domain)
    if (!tm || !mt) {
      add(`CCTP v${version} config`, false, 'missing token messenger / message transmitter')
      continue
    }
    for (const [label, address] of [['TokenMessenger', tm], ['MessageTransmitter', mt]] as const) {
      try {
        const bytecode = await code(address)
        add(`CCTP v${version} ${label} exists`, bytecode !== '0x', address)
      } catch (error) {
        add(`CCTP v${version} ${label} exists`, false, (error as Error).message, true)
      }
    }
  }

  return results
}

async function verifySolana(mode: Mode, chain: ChainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (check: string, ok: boolean, detail?: string, network = false) =>
    results.push({ mode, chain: chain.name, domain: chain.domain, check, ok, detail, network })
  const rpc = <T>(method: string, params: unknown[]) =>
    postRpc<T>(chain.rpc_url, { jsonrpc: '2.0', id: 1, method, params })

  try {
    const supply = await rpc<{ value: { decimals: number } }>('getTokenSupply', [chain.usdc_address])
    add('USDC mint exists', true, chain.usdc_address)
    add('USDC decimals = 6', supply.value.decimals === 6, `got ${supply.value.decimals}`)
  } catch (error) {
    add('USDC mint exists', false, (error as Error).message, true)
  }

  for (const version of chain.cctp_versions) {
    const { tm, mt } = cctpContracts(mode, version, chain.domain)
    for (const [label, address] of [['TokenMessenger', tm], ['MessageTransmitter', mt]] as const) {
      if (!address) {
        add(`CCTP v${version} ${label} config`, false, 'missing')
        continue
      }
      try {
        const account = await rpc<{ value: { executable: boolean } | null }>('getAccountInfo', [
          address,
          { encoding: 'base64' },
        ])
        add(
          `CCTP v${version} ${label} program exists`,
          !!account.value?.executable,
          address,
        )
      } catch (error) {
        add(`CCTP v${version} ${label} program exists`, false, (error as Error).message, true)
      }
    }
  }

  return results
}

async function verifyStellar(mode: Mode, chain: ChainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (check: string, ok: boolean, detail?: string, network = false) =>
    results.push({ mode, chain: chain.name, domain: chain.domain, check, ok, detail, network })

  const server = new stellarRpc.Server(chain.rpc_url, { allowHttp: false })
  try {
    const health = await server.getHealth()
    add('RPC reachable', health.status === 'healthy', health.status)
  } catch (error) {
    add('RPC reachable', false, (error as Error).message, true)
    return results
  }

  const instanceKey = stellarXdr.ScVal.scvLedgerKeyContractInstance()
  const contracts: Array<[string, string | undefined]> = [['USDC SAC', chain.usdc_sac]]
  for (const version of chain.cctp_versions) {
    const { tm, mt } = cctpContracts(mode, version, chain.domain)
    contracts.push([`CCTP v${version} TokenMessenger`, tm])
    contracts.push([`CCTP v${version} MessageTransmitter`, mt])
  }

  for (const [label, contractId] of contracts) {
    if (!contractId) {
      add(`${label} config`, false, 'missing')
      continue
    }
    try {
      const entry = await server.getContractData(contractId, instanceKey)
      add(`${label} exists`, !!entry, contractId)
    } catch (error) {
      add(`${label} exists`, false, (error as Error).message, true)
    }
  }

  return results
}

async function verifyAptos(mode: Mode, chain: ChainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (check: string, ok: boolean, detail?: string, network = false) =>
    results.push({ mode, chain: chain.name, domain: chain.domain, check, ok, detail, network })
  const base = chain.rpc_url.replace(/\/$/, '')
  const get = async (path: string) => {
    const res = await fetchWithTimeout(`${base}${path}`)
    return res
  }

  try {
    const res = await get(`/accounts/${chain.usdc_address}`)
    add('USDC module account exists', res.ok, `${res.status}`)
  } catch (error) {
    add('USDC module account exists', false, (error as Error).message, true)
  }

  for (const version of chain.cctp_versions) {
    const { tm, mt } = cctpContracts(mode, version, chain.domain)
    for (const [label, address] of [['TokenMessenger', tm], ['MessageTransmitter', mt]] as const) {
      if (!address) {
        add(`CCTP v${version} ${label} config`, false, 'missing')
        continue
      }
      try {
        const res = await get(`/accounts/${address}`)
        add(`CCTP v${version} ${label} account exists`, res.ok, `${res.status}`)
      } catch (error) {
        add(`CCTP v${version} ${label} account exists`, false, (error as Error).message, true)
      }
    }
  }

  return results
}

async function verifySui(mode: Mode, chain: ChainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (check: string, ok: boolean, detail?: string, network = false) =>
    results.push({ mode, chain: chain.name, domain: chain.domain, check, ok, detail, network })

  // Sui public JSON-RPC is deprecated; the app uses GraphQL, so verify via GraphQL.
  const endpoint = mode === 'mainnet'
    ? 'https://graphql.mainnet.sui.io/graphql'
    : 'https://graphql.testnet.sui.io/graphql'

  const query = async <T>(body: { query: string; variables?: Record<string, unknown> }): Promise<T> => {
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { data?: T; errors?: Array<{ message?: string }> }
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '))
    if (json.data === undefined) throw new Error('Missing GraphQL data')
    return json.data
  }

  try {
    const data = await query<{ coinMetadata: { decimals: number; symbol: string } | null }>({
      query: 'query($coinType: String!) { coinMetadata(coinType: $coinType) { decimals symbol } }',
      variables: { coinType: chain.usdc_address },
    })
    add('USDC coin metadata exists', !!data.coinMetadata, chain.usdc_address)
    add('USDC decimals = 6', data.coinMetadata?.decimals === 6, `got ${data.coinMetadata?.decimals}`)
  } catch (error) {
    add('USDC coin metadata exists', false, (error as Error).message, true)
  }

  for (const version of chain.cctp_versions) {
    const { tm, mt } = cctpContracts(mode, version, chain.domain)
    for (const [label, address] of [['TokenMessenger', tm], ['MessageTransmitter', mt]] as const) {
      if (!address) {
        add(`CCTP v${version} ${label} config`, false, 'missing')
        continue
      }
      try {
        const data = await query<{ object: { address: string } | null }>({
          query: 'query($a: SuiAddress!) { object(address: $a) { address } }',
          variables: { a: address },
        })
        add(`CCTP v${version} ${label} object exists`, !!data.object, address)
      } catch (error) {
        add(`CCTP v${version} ${label} object exists`, false, (error as Error).message, true)
      }
    }
  }

  return results
}

async function verifyStarknet(mode: Mode, chain: ChainConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const add = (check: string, ok: boolean, detail?: string, network = false) =>
    results.push({ mode, chain: chain.name, domain: chain.domain, check, ok, detail, network })
  const rpc = <T>(method: string, params: unknown[]) =>
    postRpc<T>(chain.rpc_url, { jsonrpc: '2.0', id: 1, method, params })

  try {
    const classHash = await rpc<string>('starknet_getClassHashAt', [
      'latest',
      chain.usdc_address,
    ])
    add('USDC contract exists', !!classHash, chain.usdc_address)
  } catch (error) {
    add('USDC contract exists', false, (error as Error).message, true)
  }

  for (const version of chain.cctp_versions) {
    const { tm, mt } = cctpContracts(mode, version, chain.domain)
    for (const [label, address] of [['TokenMessenger', tm], ['MessageTransmitter', mt]] as const) {
      if (!address) {
        add(`CCTP v${version} ${label} config`, false, 'missing')
        continue
      }
      try {
        const classHash = await rpc<string>('starknet_getClassHashAt', ['latest', address])
        add(`CCTP v${version} ${label} exists`, !!classHash, address)
      } catch (error) {
        add(`CCTP v${version} ${label} exists`, false, (error as Error).message, true)
      }
    }
  }

  return results
}

const verifiers: Record<ChainType, (mode: Mode, chain: ChainConfig) => Promise<CheckResult[]>> = {
  evm: verifyEvm,
  solana: verifySolana,
  stellar: verifyStellar,
  aptos: verifyAptos,
  sui: verifySui,
  starknet: verifyStarknet,
}

async function run(): Promise<void> {
  const modes: Mode[] = modeArg === 'all' ? ['mainnet', 'testnet'] : [modeArg]
  const jobs: Array<[Mode, ChainConfig]> = []
  for (const mode of modes) {
    for (const chain of config.modes[mode].chains) {
      if (typeFilter && !typeFilter.includes(chain.chain_type)) continue
      jobs.push([mode, chain])
    }
  }

  const results: CheckResult[] = []
  let cursor = 0
  async function worker() {
    while (cursor < jobs.length) {
      const [mode, chain] = jobs[cursor++]
      const verifier = verifiers[chain.chain_type]
      try {
        results.push(...await verifier(mode, chain))
      } catch (error) {
        results.push({
          mode,
          chain: chain.name,
          domain: chain.domain,
          check: 'verifier crashed',
          ok: false,
          detail: (error as Error).message,
          network: true,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))

  results.sort((a, b) =>
    a.mode.localeCompare(b.mode) || a.domain - b.domain || a.check.localeCompare(b.check),
  )

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    let current = ''
    for (const result of results) {
      const key = `${result.mode}/${result.chain}`
      if (key !== current) {
        current = key
        console.log(`\n${key} (domain ${result.domain})`)
      }
      console.log(`  ${result.ok ? 'PASS' : 'FAIL'} ${result.check}${result.detail ? ` — ${result.detail}` : ''}`)
    }
  }

  const failures = results.filter((r) => !r.ok)
  const configFailures = failures.filter((r) => !r.network)
  if (!jsonOutput) {
    const networkFailures = failures.length - configFailures.length
    console.log(
      `\n${results.length - failures.length}/${results.length} checks passed` +
      (failures.length ? `, ${failures.length} failed (${networkFailures} network/RPC errors)` : ''),
    )
    if (allowNetworkErrors && failures.length && configFailures.length === 0) {
      console.log('All failures are network/RPC errors and --allow-network-errors is set; exiting 0.')
    }
  }
  if (configFailures.length === 0 && allowNetworkErrors) process.exit(0)
  process.exit(failures.length ? 1 : 0)
}

await run()
