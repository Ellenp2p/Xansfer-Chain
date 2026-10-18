/**
 * Compare the Aptos CCTP Move scripts embedded in the app with Circle's
 * official aptos-cctp repository. If Circle ships new V2 packages/scripts,
 * this fails so the bytecode and addresses can be updated deliberately.
 *
 *   bun run verify:aptos-scripts
 *
 * Uses the GitHub API; GITHUB_TOKEN is optional but raises the rate limit.
 */

import {
  BURN_SCRIPT_BYTECODE,
  BURN_SCRIPT_BYTECODE_V2,
  BURN_SCRIPT_BYTECODE_V2_WITH_HOOK,
  RECEIVE_SCRIPT_BYTECODE,
  RECEIVE_SCRIPT_BYTECODE_V2,
} from '../src/config/aptosScripts'

const REPO = 'circlefin/aptos-cctp'
const REF = 'master'
const BASE = 'typescript/example/precompiled-move-scripts'

const scripts: Array<{ name: string; local: Record<'testnet' | 'mainnet', string>; path: (net: string) => string }> = [
  {
    name: 'v1 deposit_for_burn',
    local: BURN_SCRIPT_BYTECODE,
    path: (net) => `${BASE}/${net}/deposit_for_burn.mv`,
  },
  {
    name: 'v1 handle_receive_message',
    local: RECEIVE_SCRIPT_BYTECODE,
    path: (net) => `${BASE}/${net}/handle_receive_message.mv`,
  },
  {
    name: 'v2 deposit_for_burn',
    local: BURN_SCRIPT_BYTECODE_V2,
    path: (net) => `${BASE}/${net}/v2/deposit_for_burn.mv`,
  },
  {
    name: 'v2 deposit_for_burn_with_hook',
    local: BURN_SCRIPT_BYTECODE_V2_WITH_HOOK,
    path: (net) => `${BASE}/${net}/v2/deposit_for_burn_with_hook.mv`,
  },
  {
    name: 'v2 receive_message',
    local: RECEIVE_SCRIPT_BYTECODE_V2,
    path: (net) => `${BASE}/${net}/v2/receive_message.mv`,
  },
]

async function fetchScript(path: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xansfer-canary',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${REF}`, { headers })
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  const json = await res.json() as { content: string }
  return json.content.replace(/\n/g, '')
}

let failed = 0

for (const script of scripts) {
  for (const network of ['testnet', 'mainnet'] as const) {
    try {
      const remote = await fetchScript(script.path(network))
      const same = remote === script.local[network]
      console.log(`${same ? 'PASS' : 'FAIL'} ${script.name} (${network})`)
      if (!same) {
        failed += 1
        console.log(`  local : ${script.local[network].slice(0, 60)}...`)
        console.log(`  remote: ${remote.slice(0, 60)}...`)
      }
    } catch (error) {
      // Network/GitHub failures should not be reported as a bytecode mismatch,
      // but they must be visible.
      console.log(`ERROR ${script.name} (${network}): ${(error as Error).message}`)
      failed += 1
    }
  }
}

if (failed) {
  console.error(
    `\n${failed} Aptos script check(s) failed. If Circle upgraded the Aptos packages, update ` +
    'frontend/src/config/aptosScripts.ts, its test hashes, and config/chains.json addresses.',
  )
  process.exit(1)
}

console.log('\nAll embedded Aptos Move scripts match Circle aptos-cctp master.')
