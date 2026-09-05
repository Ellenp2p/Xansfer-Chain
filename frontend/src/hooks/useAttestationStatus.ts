import { useState, useEffect, useCallback, useRef } from 'react'
import type { TransactionStatusResponse } from '../types'
import { useNetworkMode } from '../stores/networkMode'
import { lookupEstimatedWait } from '../lib/estimate'
import * as api from '../lib/api'

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
  const mode = useNetworkMode((s) => s.mode)

  const fetchStatus = useCallback(async () => {
    if (!transactionId) return null
    try {
      const json = await api.getTransactionStatus(transactionId, mode)
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
  }, [transactionId, mode])

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
