import { useState, useEffect, useCallback, useRef } from 'react'
import type { TransactionStatusResponse } from '../types'
import { useBackendStore } from '../stores/backendStore'
import { API_BASE } from '../config/backend'

const BASE = API_BASE

/**
 * Estimated attestation wait times in seconds, by source chain + CCTP version + speed.
 * Source: Circle CCTP documentation (v1 & v2 finality tables), 2025.
 */
const ESTIMATED_WAIT_BY_CHAIN: Record<string, Record<number, { fast?: number; standard: number }>> = {
  // ── CCTP v1 ──────────────────────────────────────────────────────
  ethereum:    { 1: { standard: 1020 } },          // ~13-19min → 17min avg
  avalanche:   { 1: { standard: 8 },  2: { fast: 8, standard: 8 } },
  optimism:    { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },
  arbitrum:    { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },
  noble:       { 1: { standard: 20 } },
  base:        { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },
  polygon:     { 1: { standard: 98 },  2: { fast: 8, standard: 8 } },
  solana:      { 1: { standard: 25 },  2: { fast: 8, standard: 25 } },
  sui:         { 1: { standard: 8 } },
  aptos:       { 1: { standard: 8 } },
  unichain:    { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },

  // ── CCTP v2 additional chains ────────────────────────────────────
  linea:       { 2: { fast: 8, standard: 36000 } },   // 6-32h → 10h avg
  starknet:    { 2: { fast: 20, standard: 21600 } },   // 4-8h → 6h avg
  ink:         { 2: { fast: 8, standard: 1800 } },     // ~30min
  morph:       { 2: { fast: 8, standard: 1500 } },     // ~20-30min
  worldchain:  { 2: { fast: 8, standard: 1020 } },
  plume:       { 2: { fast: 8, standard: 1020 } },
  stellar:     { 2: { standard: 5 } },
  bsc:         { 2: { standard: 2 } },
  sonic:       { 2: { standard: 8 } },
  sei:         { 2: { standard: 5 } },
  monad:       { 2: { standard: 5 } },
  hyperliquid: { 2: { standard: 5 } },
  xdc:         { 2: { standard: 10 } },
  cronos:      { 2: { standard: 1 } },
  arc:         { 2: { standard: 1 } },
  injective:   { 2: { standard: 1 } },
  pharos:      { 2: { standard: 7 } },
  codex:       { 2: { fast: 8, standard: 1020 } },
  edge:        { 2: { fast: 8, standard: 1140 } },
}

/** CCTP domain number → canonical chain key for ESTIMATED_WAIT_BY_CHAIN. */
const DOMAIN_TO_CHAIN: Record<number, string> = {
  0: 'ethereum',
  1: 'avalanche',
  2: 'optimism',
  3: 'arbitrum',
  4: 'noble',
  6: 'base',
  7: 'polygon',
  8: 'linea',
  9: 'starknet',
  10: 'solana',
  11: 'worldchain',
  12: 'unichain',
  13: 'ink',
  14: 'morph',
  15: 'plume',
  16: 'sei',
  17: 'monad',
  18: 'hyperliquid',
  19: 'codex',
  20: 'edge',
  21: 'sonic',
  22: 'cronos',
  23: 'injective',
  24: 'arc',
  25: 'pharos',
  26: 'xdc',
  27: 'stellar',
  28: 'bsc',
  // Noble domain varies by version — handled as fallback
  50: 'noble',  // some deployments use 50
}

function lookupEstimatedWait(
  sourceDomain: number | undefined,
  cctpVersion: number | undefined,
  isFast: boolean,
): number {
  const key = sourceDomain != null ? DOMAIN_TO_CHAIN[sourceDomain] : undefined
  const ver = cctpVersion ?? (isFast ? 2 : 1)
  if (key) {
    const chain = ESTIMATED_WAIT_BY_CHAIN[key]?.[ver]
    if (chain) return isFast ? (chain.fast ?? chain.standard) : chain.standard
  }
  // Fallback: fast → 30s, standard → 18min
  return isFast ? 30 : 1080
}

const POLL_NORMAL = 60_000   // 60s while within estimated time
const POLL_FAST = 10_000     // 10s after estimated time passes

export function useAttestationStatus(
  transactionId: string | null,
  enabled: boolean,
) {
  const [data, setData] = useState<TransactionStatusResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const createdAtRef = useRef<number>(0)
  const fastPollingRef = useRef(false)

  const fetchStatus = useCallback(async () => {
    if (!transactionId) return null
    // Skip while backend is known offline; keeps the timer alive but avoids spamming the proxy.
    if (!useBackendStore.getState().online) return null
    try {
      const res = await fetch(`${BASE}/transactions/${transactionId}/status`, {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const json: TransactionStatusResponse = await res.json()
      setData(json)
      setError(null)

      // Record transaction creation time for elapsed calculation
      if (createdAtRef.current === 0 && json?.transaction.created_at) {
        createdAtRef.current = new Date(json.transaction.created_at).getTime()
      }

      return json
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed')
      return null
    } finally {
      setIsLoading(false)
    }
  }, [transactionId])

  useEffect(() => {
    if (!enabled || !transactionId) return

    createdAtRef.current = 0
    setElapsed(0)
    fastPollingRef.current = false

    // Initial fetch
    fetchStatus().then((json) => {
      if (json?.transaction.status === 'complete' || json?.claimed) return
      startPolling(POLL_NORMAL)
    })

    // 1-second tick — elapsed from transaction creation time
    tickRef.current = setInterval(() => {
      if (createdAtRef.current > 0) {
        setElapsed(Math.floor((Date.now() - createdAtRef.current) / 1000))
      }
    }, 1000)

    function startPolling(interval: number) {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = setInterval(async () => {
        const json = await fetchStatus()
        if (json?.transaction.status === 'complete' || json?.claimed) {
          if (timerRef.current) clearInterval(timerRef.current)
        }
      }, interval)
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [enabled, transactionId, fetchStatus])

  // Switch to faster polling after estimated wait time
  useEffect(() => {
    if (!enabled || !data || fastPollingRef.current) return
    if (data.transaction.status === 'complete' || data.claimed) return

    const tx = data.transaction
    const isFast = tx.transfer_type === 'fast'
    const estimated = lookupEstimatedWait(tx.source_domain, tx.cctp_version, isFast)
    if (elapsed < estimated) return

    // Switch to fast polling
    fastPollingRef.current = true
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(async () => {
      const json = await fetchStatus()
      if (json?.transaction.status === 'complete' || json?.claimed) {
        if (timerRef.current) clearInterval(timerRef.current)
      }
    }, POLL_FAST)
  }, [elapsed, enabled, data, fetchStatus])

  const refetch = useCallback(() => {
    setIsLoading(true)
    fetchStatus()
  }, [fetchStatus])

  const tx = data?.transaction
  const isFast = tx ? tx.transfer_type === 'fast' : false
  const estimatedWait = tx ? lookupEstimatedWait(tx.source_domain, tx.cctp_version, isFast) : null

  return { data, isLoading, error, refetch, elapsed, estimatedWait }
}
