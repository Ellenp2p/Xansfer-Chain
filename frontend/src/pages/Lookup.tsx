import { useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Loader2, AlertCircle, ArrowRight } from 'lucide-react'
import { useNetworkMode } from '../stores/networkMode'
import { getChains, withModePrefix } from '../config/chains'
import { lookupTransaction } from '../lib/api'

export default function Lookup() {
  const navigate = useNavigate()
  const mode = useNetworkMode((s) => s.mode)

  const [hash, setHash] = useState('')
  const [sourceDomain, setSourceDomain] = useState('')
  const [destDomain, setDestDomain] = useState('')
  const [amount, setAmount] = useState('')
  const [cctpVersion, setCctpVersion] = useState('2')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)

  const chains = useMemo(() => getChains(mode), [mode])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setError(null)

    const domain = parseInt(sourceDomain, 10)
    if (!hash.trim() || Number.isNaN(domain)) {
      setError('Enter a transaction hash and source chain')
      submittingRef.current = false
      return
    }

    setLoading(true)
    try {
      const json = await lookupTransaction(
        hash.trim(),
        domain,
        mode,
        parseInt(cctpVersion, 10),
        destDomain.trim() ? parseInt(destDomain, 10) : undefined,
        amount.trim(),
      )
      if (!json.transaction) {
        throw new Error('No transaction found for this hash')
      }
      navigate(withModePrefix(mode, `/tx/${json.transaction.source_tx_hash}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setLoading(false)
      submittingRef.current = false
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 sm:p-6">
        <h1 className="mb-2 text-xl font-semibold">Manual Transaction Lookup</h1>
        <p className="mb-5 text-sm text-gray-400">
          Recover a CCTP transfer that isn't in your local history. We'll query Circle's Iris API and create a tracking record.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Source Transaction Hash</label>
            <input
              type="text"
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="0x... (EVM) or hex hash (Stellar/Solana)"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 font-mono text-sm text-white placeholder-gray-600 outline-none focus:border-brand-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Source Chain</label>
            <select
              value={sourceDomain}
              onChange={(e) => setSourceDomain(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white outline-none focus:border-brand-500"
            >
              <option value="">Select source chain...</option>
              {chains.map((c) => (
                <option key={c.domain} value={c.domain}>
                  {c.name} (domain {c.domain})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">Dest Domain (optional)</label>
              <input
                type="number"
                value={destDomain}
                onChange={(e) => setDestDomain(e.target.value)}
                placeholder="auto"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-400">Amount (optional)</label>
              <input
                type="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="auto"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-brand-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">CCTP Version</label>
            <select
              value={cctpVersion}
              onChange={(e) => setCctpVersion(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-white outline-none focus:border-brand-500"
            >
              <option value="2">v2</option>
              <option value="1">v1</option>
            </select>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {loading ? 'Looking up...' : 'Lookup Transfer'}
          </button>
        </form>
      </div>

      <button
        onClick={() => navigate(withModePrefix(mode, '/'))}
        className="flex items-center justify-center gap-1 text-sm text-gray-400 hover:text-white"
      >
        Back to Transfer <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  )
}
