import type {
  ChainConfig,
  Transaction,
  TransactionStatusResponse,
  CreateTransactionRequest,
  LookupResponse,
} from '../types'
import { queryIris, isAttestationReady, type IrisMessage } from './iris'
import {
  upsertLocalTx,
  getLocalTx,
  listLocalTxs,
  markLocalClaimed,
} from './localTx'
import type { Mode } from '../config/chains'

const BASE = '/api'

// ── Backend availability probe ───────────────────────────────────────────────
// The frontend works standalone: when the backend is unreachable it degrades to
// direct Circle Iris queries + localStorage. The probe result is cached.

let backendUp: boolean | null = null
let lastProbe = 0
const PROBE_TTL = 30_000

export function isBackendAvailable(): boolean | null {
  return backendUp
}

export async function probeBackend(): Promise<boolean> {
  if (backendUp !== null && Date.now() - lastProbe < PROBE_TTL) return backendUp
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${BASE}/chains?mode=testnet`, { signal: ctrl.signal })
    clearTimeout(timer)
    backendUp = res.ok
  } catch {
    backendUp = false
  }
  lastProbe = Date.now()
  return backendUp
}

export function setBackendAvailable(v: boolean) {
  backendUp = v
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

// ── Chains ───────────────────────────────────────────────────────────────────

export async function fetchChains(): Promise<{ chains: ChainConfig[] }> {
  return fetchJson('/chains')
}

// ── Transaction creation ─────────────────────────────────────────────────────

export async function createTransaction(
  req: CreateTransactionRequest,
  mode: Mode,
): Promise<{ transaction: Transaction }> {
  if (await probeBackend()) {
    try {
      return await fetchJson('/transactions', { method: 'POST', body: JSON.stringify(req) })
    } catch {
      // fall through to local
    }
  }

  const now = new Date().toISOString()
  const tx: Transaction = {
    id: req.source_tx_hash,
    source_domain: req.source_domain,
    dest_domain: req.dest_domain,
    source_tx_hash: req.source_tx_hash,
    source_address: req.source_address,
    dest_address: req.dest_address,
    amount: req.amount,
    status: 'pending',
    cctp_version: req.cctp_version ?? 2,
    transfer_type: req.transfer_type ?? 'standard',
    network_mode: mode,
    attestation: null,
    message: null,
    dest_tx_hash: null,
    error_message: null,
    created_at: now,
    updated_at: now,
  }
  upsertLocalTx(tx)
  return { transaction: tx }
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function getTransactionStatus(
  sourceTxHash: string,
  mode: Mode,
): Promise<TransactionStatusResponse> {
  if (await probeBackend()) {
    try {
      return await fetchJson(`/transactions/${sourceTxHash}/status`)
    } catch {
      // fall through to local
    }
  }

  const tx = getLocalTx(sourceTxHash, mode)
  if (!tx) throw new Error(`Transaction not found (${sourceTxHash})`)

  const iris = await queryIris(tx.source_domain, sourceTxHash, tx.cctp_version, mode)
  const local = computeLocalStatus(tx, iris)
  upsertLocalTx(local.transaction)
  return local
}

function computeLocalStatus(
  tx: Transaction,
  iris: IrisMessage | null,
): TransactionStatusResponse {
  let { status, attestation, message, dest_tx_hash } = tx
  const claimed = status === 'complete' || !!tx.claimed_at

  if (iris && isAttestationReady(iris.attestation)) {
    attestation = iris.attestation
    message = iris.message
    if (iris.forward_state === 'COMPLETE') {
      status = 'complete'
      dest_tx_hash = iris.forward_tx_hash ?? tx.dest_tx_hash
    } else {
      status = 'attested'
    }
  }

  return {
    transaction: { ...tx, status, attestation, message, dest_tx_hash, updated_at: new Date().toISOString() },
    attestation_ready: isAttestationReady(attestation),
    can_claim: isAttestationReady(attestation) && status === 'attested',
    claimed,
    relay_job: null,
  }
}

// ── History ──────────────────────────────────────────────────────────────────

export async function listTransactions(
  addresses: string[],
  mode: Mode,
): Promise<{ transactions: Transaction[] }> {
  if (await probeBackend()) {
    try {
      const params = new URLSearchParams()
      addresses.forEach((a) => params.append('address', a))
      return await fetchJson(`/transactions/address?${params.toString()}`)
    } catch {
      // fall through to local
    }
  }

  return { transactions: listLocalTxs(addresses, mode) }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export async function lookupTransaction(
  sourceTxHash: string,
  sourceDomain: number,
  mode?: Mode,
  cctpVersion?: number,
  destDomain?: number,
  amount?: string,
): Promise<LookupResponse> {
  const netMode = mode ?? 'mainnet'
  if (await probeBackend()) {
    try {
      const params = new URLSearchParams({
        source_tx_hash: sourceTxHash,
        source_domain: String(sourceDomain),
        mode: netMode,
      })
      if (cctpVersion) params.set('cctp_version', String(cctpVersion))
      if (destDomain) params.set('dest_domain', String(destDomain))
      if (amount) params.set('amount', amount)
      return await fetchJson(`/lookup?${params}`)
    } catch {
      // fall through to local
    }
  }

  const iris = await queryIris(sourceDomain, sourceTxHash, cctpVersion ?? 2, netMode)
  const existing = getLocalTx(sourceTxHash, netMode)
  if (existing) {
    return { transaction: existing, circle_status: toCircleStatus(iris) }
  }
  if (iris && isAttestationReady(iris.attestation)) {
    const tx = synthTxFromIris(sourceDomain, sourceTxHash, iris, netMode)
    upsertLocalTx(tx)
    return { transaction: tx, circle_status: toCircleStatus(iris) }
  }
  return { transaction: null, circle_status: toCircleStatus(iris) }
}

function synthTxFromIris(
  sourceDomain: number,
  sourceTxHash: string,
  iris: IrisMessage,
  mode: Mode,
): Transaction {
  const now = new Date().toISOString()
  const forwardComplete = iris.forward_state === 'COMPLETE'
  return {
    id: sourceTxHash,
    source_domain: sourceDomain,
    dest_domain: 0,
    source_tx_hash: sourceTxHash,
    source_address: '',
    dest_address: '',
    amount: '0',
    status: forwardComplete ? 'complete' : 'attested',
    cctp_version: iris.cctp_version ?? 2,
    transfer_type: 'standard',
    network_mode: mode,
    attestation: iris.attestation,
    message: iris.message,
    dest_tx_hash: forwardComplete ? iris.forward_tx_hash : null,
    error_message: null,
    created_at: now,
    updated_at: now,
  }
}

function toCircleStatus(iris: any) {
  if (!iris) return null
  return {
    message: iris.message,
    event_nonce: iris.event_nonce,
    attestation: iris.attestation,
    cctp_version: iris.cctp_version,
    status: iris.status,
    forward_state: iris.forward_state,
    forward_tx_hash: iris.forward_tx_hash,
  }
}

// ── Claim reporting ──────────────────────────────────────────────────────────

export async function reportClaim(
  sourceTxHash: string,
  destTxHash: string,
  mode: Mode,
): Promise<void> {
  if (await probeBackend()) {
    try {
      await fetchJson(`/transactions/${sourceTxHash}/claim`, {
        method: 'POST',
        body: JSON.stringify({ dest_tx_hash: destTxHash }),
      })
      return
    } catch {
      // fall through to local
    }
  }
  markLocalClaimed(sourceTxHash, mode, destTxHash)
}
