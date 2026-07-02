import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { isConnected as freighterIsConnected, getAddress, requestAccess } from '@stellar/freighter-api'

interface StellarWalletState {
  address: string | null
  connected: boolean
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

const StellarWalletContext = createContext<StellarWalletState | null>(null)

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout>

    async function tryReconnect(attempt = 0) {
      if (cancelled) return
      try {
        const result = await freighterIsConnected()
        if (cancelled) return
        if (result.isConnected && !result.error) {
          const res = await getAddress()
          if (cancelled) return
          if (res.address && !res.error) {
            setAddress(res.address)
            setConnected(true)
            return // success — stop retrying
          }
        }
      } catch {
        // ignore
      }
      // Retry up to 3 times with increasing delay (Freighter extension may still be loading)
      if (!cancelled && attempt < 3) {
        retryTimer = setTimeout(() => tryReconnect(attempt + 1), (attempt + 1) * 1500)
      }
    }

    tryReconnect()

    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [])

  const connect = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      const result = await requestAccess()
      if (result.error) {
        throw new Error(result.error.message || 'Freighter access denied')
      }
      setAddress(result.address)
      setConnected(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Freighter connection failed')
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(() => {
    setAddress(null)
    setConnected(false)
  }, [])

  return (
    <StellarWalletContext.Provider
      value={{ address, connected, connecting, error, connect, disconnect }}
    >
      {children}
    </StellarWalletContext.Provider>
  )
}

export function useStellarWallet(): StellarWalletState {
  const ctx = useContext(StellarWalletContext)
  if (!ctx) throw new Error('useStellarWallet must be used within StellarWalletProvider')
  return ctx
}
