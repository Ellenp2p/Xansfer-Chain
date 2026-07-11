import { useEffect, useRef } from 'react'
import { useBackendStore } from '../stores/backendStore'
import { API_BASE } from '../config/backend'

const CHECK_URL = `${API_BASE}/chains`
const TIMEOUT_MS = 5000
const ONLINE_INTERVAL_MS = 10_000
const OFFLINE_BASE_MS = 5_000
const OFFLINE_MAX_MS = 5 * 60_000 // 5 minutes cap

function nextOfflineInterval(offlineChecks: number): number {
  return Math.min(OFFLINE_BASE_MS * 2 ** offlineChecks, OFFLINE_MAX_MS)
}

async function probeBackend(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(CHECK_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Global backend connectivity poller.
 *
 * - Checks every 10s while backend is reachable.
 * - Backs off exponentially (5s → 10s → 20s → … up to 5min) while unreachable.
 * - Pauses entirely when the tab is hidden/backgrounded.
 * - Resumes immediately when the tab becomes visible or the browser comes back online.
 */
export function useBackendPoller() {
  const markCheck = useBackendStore((s) => s.markCheck)
  const onlineRef = useRef(useBackendStore.getState().online)
  const offlineChecksRef = useRef(useBackendStore.getState().offlineChecks)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    const unsub = useBackendStore.subscribe((state) => {
      onlineRef.current = state.online
      offlineChecksRef.current = state.offlineChecks
    })
    return unsub
  }, [])

  useEffect(() => {
    cancelledRef.current = false

    const runCheck = async () => {
      if (cancelledRef.current) return
      const ok = await probeBackend()
      if (cancelledRef.current) return
      markCheck(ok)
    }

    const schedule = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      const interval = onlineRef.current
        ? ONLINE_INTERVAL_MS
        : nextOfflineInterval(offlineChecksRef.current)
      timeoutRef.current = setTimeout(async () => {
        await runCheck()
        if (!cancelledRef.current) schedule()
      }, interval)
    }

    const handleVisible = () => {
      if (!document.hidden) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        runCheck().then(schedule)
      }
    }

    const handleOnline = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      runCheck().then(schedule)
    }

    runCheck().then(schedule)

    document.addEventListener('visibilitychange', handleVisible)
    window.addEventListener('online', handleOnline)

    return () => {
      cancelledRef.current = true
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      document.removeEventListener('visibilitychange', handleVisible)
      window.removeEventListener('online', handleOnline)
    }
  }, [markCheck])
}

export function BackendPoller() {
  useBackendPoller()
  return null
}
