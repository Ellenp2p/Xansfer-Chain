import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as Freighter from '@stellar/freighter-api'
import type { ChainActions, ConnectedChainType, WalletOption, WalletSlot } from '../core/types'

type SetSlot = (chain: ConnectedChainType, patch: Partial<WalletSlot>) => void
type RegisterActions = (chain: ConnectedChainType, actions: ChainActions) => void

// freighter-api's published types reference an unresolvable internal alias
// (@shared/api/types), which degrades inference. Keep explicit local types.
type AddressResult = { address: string; error?: unknown }
type ConnectedResult = { isConnected: boolean; error?: unknown }

interface Props {
  setSlot: SetSlot
  registerActions: RegisterActions
  children: ReactNode
}

export function StellarAdapter({ setSlot, registerActions, children }: Props) {
  return (
    <StellarSync setSlot={setSlot} registerActions={registerActions}>
      {children}
    </StellarSync>
  )
}

function StellarSync({ setSlot, registerActions, children }: Props & { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Silent probe on mount (extension may load late).
  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined

    async function probe(attempt = 0) {
      if (cancelled) return
      try {
        const installed = (await Freighter.isConnected()) as ConnectedResult
        if (cancelled || installed.error || !installed.isConnected) {
          setConnected(false)
        } else {
          const res = (await Freighter.getAddress()) as AddressResult
          if (cancelled) return
          if (res.error || !res.address) {
            setConnected(false)
          } else {
            setAddress(res.address)
            setConnected(true)
            return
          }
        }
      } catch {
        // ignore
      }
      if (!cancelled && attempt < 3) {
        retry = setTimeout(() => probe(attempt + 1), (attempt + 1) * 1500)
      }
    }

    probe()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
    }
  }, [])

  useEffect(() => {
    setSlot('stellar', {
      wallet: connected && address ? { address, chainType: 'stellar' } : null,
      connecting,
      error,
    })
  }, [address, connected, connecting, error, setSlot])

  const connect = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      const res = (await Freighter.requestAccess()) as AddressResult
      if (res.error) {
        const msg = typeof res.error === 'string' ? res.error : 'Freighter access denied'
        throw new Error(msg)
      }
      if (!res.address) throw new Error('Freighter access denied')
      setAddress(res.address)
      setConnected(true)
      return { address: res.address, chainType: 'stellar' as const }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Freighter connection failed')
      return null
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    setAddress(null)
    setConnected(false)
  }, [])

  const getAddress = useCallback(() => (connected && address ? address : null), [address, connected])

  const walletOptions: WalletOption[] = useMemo(
    () => [{ id: 'freighter', name: 'Freighter' }],
    [],
  )

  useEffect(() => {
    registerActions('stellar', { chainType: 'stellar', wallets: walletOptions, connect, disconnect, getAddress })
  }, [registerActions, walletOptions, connect, disconnect, getAddress])

  return <>{children}</>
}
