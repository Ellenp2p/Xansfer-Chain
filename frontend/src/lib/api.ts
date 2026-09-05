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
import { getChainByDomain } from '../config/chains'

const BASE = '/api'

const EVM_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const STELLAR_TX_HASH_RE = /^[0-9a-f]{64}$/
const SOLANA_TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{80,95}$/

export function isPlausibleDestTxHash(destTxHash: string, destDomain: number, mode: Mode): boolean {
  switch (getChainByDomain(destDomain, mode)?.chain_type) {
    case 'evm':
    case 'starknet':
    case 'aptos':
    case 'sui':
      return EVM_TX_HASH_RE.test(destTxHash)
    case 'stellar':
      return STELLAR_TX_HASH_RE.test(destTxHash)
    case 'solana':
      return SOLANA_TX_HASH_RE.test(destTxHash)
    default:
      return true
  }
}

// The backend claim endpoint is unauthenticated, so a "complete" status is not
// proof of minting. Downgrade completions whose destination tx hash is absent
// or malformed for the destination chain — the user can still claim for real.
function sanitizeBackendStatus(res: TransactionStatusResponse, mode: Mode): TransactionStatusResponse {
  const tx = res.transaction
  if (tx.network_mode && tx.network_mode !== mode) {
    throw new Error(`Transaction belongs to ${tx.network_mode}, not ${mode}`)
  }
  if (tx.status !== 'complete') return res
  const hasProof = !!tx.dest_tx_hash || !!tx.claimed_at
  const hashOk = !tx.dest_tx_hash || isPlausibleDestTxHash(tx.dest_tx_hash, tx.dest_domain, mode)
  if (hasProof && hashOk) return res
  const attestationReady = isAttestationReady(tx.attestation)
  const status = attestationReady ? 'attested' : 'pending'
  return {
    ...res,
    transaction: { ...tx, status },
    attestation_ready: attestationReady,
    can_claim: attestationReady && status === 'attested',
    claimed: false,
  }
}

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
      const res = await fetchJson<TransactionStatusResponse>(`/transactions/${sourceTxHash}/status?mode=${mode}`)
      return sanitizeBackendStatus(res, mode)
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
      params.set('mode', mode)
      const res = await fetchJson<{ transactions: Transaction[] }>(`/transactions/address?${params.toString()}`)
      return { transactions: res.transactions.filter((tx) => !tx.network_mode || tx.network_mode === mode) }
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
      const res = await fetchJson<LookupResponse>(`/lookup?${params}`)
      if (res.transaction && res.transaction.network_mode && res.transaction.network_mode !== netMode) {
        return { transaction: null, circle_status: res.circle_status }
      }
      return res
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
      await fetchJson(`/transactions/${sourceTxHash}/claim?mode=${mode}`, {
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
