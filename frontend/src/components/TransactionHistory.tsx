import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWalletStore } from '../stores/walletStore'
import { useHistoryStore } from '../stores/historyStore'
import { useNetworkMode } from '../stores/networkMode'
import type { TxStatus } from '../types'
import { ExternalLink, Search } from 'lucide-react'
import { lookupTransaction } from '../lib/api'
import { getChains } from '../config/chains'

const STATUS_COLORS: Record<TxStatus, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  attested: 'bg-blue-500/20 text-blue-400',
  minting: 'bg-purple-500/20 text-purple-400',
  complete: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
}

export default function TransactionHistory() {
  const { evm, solana, stellar, aptos, sui } = useWalletStore()
  const { transactions, loading, error, fetchTransactions } = useHistoryStore()
  const { mode } = useNetworkMode()
  const navigate = useNavigate()

  const addresses = useMemo(
    () => [evm?.address, solana?.address, stellar?.address, aptos?.address, sui?.address].filter(Boolean) as string[],
    [evm?.address, solana?.address, stellar?.address, aptos?.address, sui?.address],
  )
  const connected = addresses.length > 0

  const chains = useMemo(() => getChains(mode), [mode])

  // Manual lookup state
  const [lookupHash, setLookupHash] = useState('')
  const [lookupDomain, setLookupDomain] = useState(String(chains[0]?.domain ?? 0))
  const [lookupResult, setLookupResult] = useState<string | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)

  // Keep the lookup chain selection valid when the network mode changes
  useEffect(() => {
    setLookupDomain(String(chains[0]?.domain ?? 0))
  }, [mode])

  useEffect(() => {
    if (connected) fetchTransactions(addresses, mode)
  }, [connected, addresses, fetchTransactions, mode])

  async function handleLookup() {
    if (!lookupHash.trim()) return
    setLookupLoading(true)
    setLookupResult(null)
    try {
      const res = await lookupTransaction(lookupHash.trim(), parseInt(lookupDomain), mode)
      if (res.transaction) {
        navigate(`/tx/${res.transaction.source_tx_hash}`)
      } else if (res.circle_status) {
        setLookupResult(
          `Circle status: ${res.circle_status.status ?? 'unknown'} — attestation ${res.circle_status.attestation ? 'available' : 'pending'}`,
        )
      } else {
        setLookupResult('No transaction found for this hash')
      }
    } catch (e) {
      setLookupResult(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setLookupLoading(false)
    }
  }

  if (!connected) {
    return (
      <div className="py-20 text-center text-gray-500">
        Connect your wallet to view transaction history
      </div>
    )
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Manual Lookup */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
          <Search className="h-5 w-5 text-brand-500" />
          Manual Lookup
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            placeholder="Transaction hash (0x...)"
            value={lookupHash}
            onChange={(e) => setLookupHash(e.target.value)}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 font-mono text-sm text-white placeholder-gray-600 outline-none focus:border-brand-500"
          />
          <select
            value={lookupDomain}
            onChange={(e) => setLookupDomain(e.target.value)}
            className="w-full sm:w-auto rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white outline-none"
          >
            {chains.map((c) => (
              <option key={c.domain} value={c.domain}>
                {c.name} ({c.domain})
              </option>
            ))}
          </select>
          <button
            onClick={handleLookup}
            disabled={lookupLoading}
            className="w-full sm:w-auto rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-medium transition hover:bg-brand-700 disabled:opacity-50"
          >
            {lookupLoading ? 'Looking...' : 'Lookup'}
          </button>
        </div>
        {lookupResult && (
          <p className="mt-3 text-sm text-gray-400 break-words">{lookupResult}</p>
        )}
      </div>

      {/* Transaction list */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
        <h2 className="mb-4 text-lg font-semibold">Recent Transactions</h2>
        {loading && <p className="text-sm text-gray-500">Loading...</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!loading && transactions.length === 0 && (
          <p className="py-8 text-center text-sm text-gray-500">No transactions yet</p>
        )}
        <div className="divide-y divide-gray-800">
          {transactions.map((tx) => (
            <button
              key={tx.source_tx_hash}
              onClick={() => navigate(`/tx/${tx.source_tx_hash}`)}
              className="flex w-full items-center justify-between gap-3 py-4 text-left transition hover:bg-gray-800/50 -mx-4 sm:-mx-6 px-4 sm:px-6 overflow-hidden"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs text-gray-400 truncate">
                  {tx.source_tx_hash.slice(0, 10)}...{tx.source_tx_hash.slice(-8)}
                </p>
                <p className="mt-1 text-sm truncate">
                  Domain {tx.source_domain} → {tx.dest_domain} · {tx.amount} USDC
                </p>
              </div>
              <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                <span className={`rounded-full px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-medium ${STATUS_COLORS[tx.status] ?? ''}`}>
                  {tx.status}
                </span>
                <ExternalLink className="h-4 w-4 text-gray-600" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
