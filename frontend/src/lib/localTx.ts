import type { Transaction } from '../types'

const KEY = 'xansfer-local-txs'

type TxMap = Record<string, Transaction>

function load(): TxMap {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as TxMap) : {}
  } catch {
    return {}
  }
}

function save(map: TxMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // storage full or unavailable — non-fatal
  }
}

function txKey(tx: Transaction): string {
  return `${tx.network_mode ?? 'mainnet'}:${tx.source_tx_hash}`
}

/** Persist (or update) a locally-tracked transaction. */
export function upsertLocalTx(tx: Transaction) {
  const map = load()
  map[txKey(tx)] = tx
  save(map)
}

export function getLocalTx(sourceTxHash: string, mode: string): Transaction | undefined {
  const map = load()
  return map[`${mode}:${sourceTxHash}`]
}

/** List locally-tracked transactions matching any of the given addresses for a mode. */
export function listLocalTxs(addresses: string[], mode: string): Transaction[] {
  if (addresses.length === 0) return []
  const addrSet = new Set(addresses)
  const map = load()
  return Object.values(map)
    .filter((tx) => (tx.network_mode ?? 'mainnet') === mode && tx.source_address && addrSet.has(tx.source_address))
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}

/** Record a locally-performed claim so the status page shows completion without the backend. */
export function markLocalClaimed(sourceTxHash: string, mode: string, destTxHash: string) {
  const tx = getLocalTx(sourceTxHash, mode)
  if (!tx) return
  upsertLocalTx({
    ...tx,
    status: 'complete',
    dest_tx_hash: destTxHash || tx.dest_tx_hash,
    claimed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
}
