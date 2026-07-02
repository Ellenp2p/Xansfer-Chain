import type {
  ChainConfig,
  Transaction,
  TransactionStatusResponse,
  CreateTransactionRequest,
  LookupResponse,
} from '../types'

const BASE = '/api'

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

export async function fetchChains(): Promise<{ chains: ChainConfig[] }> {
  return fetchJson('/chains')
}

export async function fetchTransferTypes(
  source: number,
  dest: number,
): Promise<{ transfer_types: string[] }> {
  return fetchJson(`/transfer-types/${source}/${dest}`)
}

export async function createTransaction(
  req: CreateTransactionRequest,
): Promise<{ transaction: Transaction }> {
  return fetchJson('/transactions', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export async function getTransaction(id: string): Promise<TransactionStatusResponse> {
  return fetchJson(`/transactions/${id}/status`)
}

export async function listTransactions(
  address: string,
): Promise<{ transactions: Transaction[] }> {
  return fetchJson(`/transactions/address/${encodeURIComponent(address)}`)
}

export async function lookupTransaction(
  sourceTxHash: string,
  sourceDomain: number,
): Promise<LookupResponse> {
  const params = new URLSearchParams({
    source_tx_hash: sourceTxHash,
    source_domain: String(sourceDomain),
  })
  return fetchJson(`/lookup?${params}`)
}
