import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BURN_SCRIPT_BYTECODE,
  BURN_SCRIPT_BYTECODE_V2,
  BURN_SCRIPT_BYTECODE_V2_WITH_HOOK,
  RECEIVE_SCRIPT_BYTECODE,
  RECEIVE_SCRIPT_BYTECODE_V2,
} from './aptosScripts'

// SHA-256 of the decoded .mv files pinned to the current Circle aptos-cctp
// master. The network check (bun run verify:aptos-scripts) detects upstream
// changes; this test detects accidental local edits.
const EXPECTED = {
  BURN_SCRIPT_BYTECODE: {
    testnet: '803588c717910794c57763beb009ec0cb4ec62e186dcae7bdcc85669641d47e8',
    mainnet: 'a1118b4357d55a3c638576f6c47d6859e1e31f93f4b881127ecdf4e0c1a0c5ac',
  },
  RECEIVE_SCRIPT_BYTECODE: {
    testnet: '41658fda33c01bb0aa4b81f6197e41732f54e346a16d69eeefb953961a8e7c66',
    mainnet: 'c0da30dbacdc03903a0c8cee125df895b0c66d9c0eae6ad97c1038f09c50375b',
  },
  BURN_SCRIPT_BYTECODE_V2: {
    testnet: '50bc42993a291b58660ca86246cb8a06076fc4ca7738be4520d7ec88d2107596',
    mainnet: '8447c14c4f7d1edcc0bed97f46bb8db2cc67663cf8a948b2b4f25a0c7eb5744c',
  },
  RECEIVE_SCRIPT_BYTECODE_V2: {
    testnet: '16d2011ea6ad8365cbf9dbb4edb8e787df3854668c1469b1ca790748bdeaa8e8',
    mainnet: '8b3dc2a420857b428be2e13ac098a5ca4d273f97b5d8837977a2c04c3aaebe67',
  },
  BURN_SCRIPT_BYTECODE_V2_WITH_HOOK: {
    testnet: '39ae7dfcff64e18f4079e5067ed6d652f7c9fc9df4e96a7c3513361df71fd316',
    mainnet: 'a06ef2513f2406f72c396e76ac7825791a9b229567b14ae56be8e04ccbc697c3',
  },
} as const

const SCRIPTS = {
  BURN_SCRIPT_BYTECODE,
  RECEIVE_SCRIPT_BYTECODE,
  BURN_SCRIPT_BYTECODE_V2,
  RECEIVE_SCRIPT_BYTECODE_V2,
  BURN_SCRIPT_BYTECODE_V2_WITH_HOOK,
} as const

describe('Aptos CCTP Move scripts', () => {
  for (const [name, byNetwork] of Object.entries(SCRIPTS)) {
    for (const network of ['testnet', 'mainnet'] as const) {
      it(`${name} ${network} matches the pinned Circle bytecode`, () => {
        const bytes = Buffer.from(byNetwork[network], 'base64')
        expect(bytes.length).toBeGreaterThan(100)
        const hash = createHash('sha256').update(bytes).digest('hex')
        expect(hash).toBe(EXPECTED[name as keyof typeof EXPECTED][network])
      })
    }
  }
})
