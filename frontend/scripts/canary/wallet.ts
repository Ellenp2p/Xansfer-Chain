/**
 * Print the canary wallet addresses derived from CANARY_MNEMONIC.
 *
 *   bun run canary:wallet
 *   CANARY_ACCOUNT_INDEX=1 bun run canary:wallet
 *
 * Read-only: no network, no transactions, and never prints secrets.
 */

import { deriveAllWallets } from '../../src/lib/canaryWallet'
import { addressOverride, mnemonicFor } from './core'

function main(): void {
  const mnemonic = mnemonicFor()
  const index = Number(process.env.CANARY_ACCOUNT_INDEX ?? '0')
  if (!mnemonic) {
    console.error('[canary] CANARY_MNEMONIC is not set; export it or put it in frontend/.env.local')
    process.exit(1)
  }

  const rows: Array<{ chain: string; address: string; path: string }> = []
  for (const wallet of deriveAllWallets(mnemonic, { index })) {
    if (wallet.derived) {
      rows.push({ chain: wallet.chainType, address: wallet.address, path: wallet.path ?? '' })
      continue
    }
    rows.push({
      chain: wallet.chainType,
      address: addressOverride(wallet.chainType) ?? '(set CANARY_STARKNET_ADDRESS)',
      path: '(not derivable from mnemonic)',
    })
  }

  console.log(`[canary] account index ${index}`)
  const width = Math.max(...rows.map((row) => row.chain.length))
  for (const row of rows) {
    console.log(`  ${row.chain.padEnd(width)}  ${row.address}  ${row.path}`)
  }
}

main()
