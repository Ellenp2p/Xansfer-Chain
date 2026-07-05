import { useState, useEffect, useCallback } from 'react'
import {
  isConnected,
  getAddress,
  requestAccess,
  getNetwork,
  signTransaction,
} from '@stellar/freighter-api'

export interface FreighterState {
  installed: boolean
  connected: boolean
  address: string | null
  network: string | null   // "TESTNET" | "PUBLIC" | etc.
  loading: boolean
  error: string | null
}

/**
 * React hook for Freighter wallet following Stellar dapp skill best practices.
 *
 * Detection flow (from skill):
 *   1. isConnected()  — is the extension installed?
 *   2. getAddress()   — returns "" until the app has been granted access
 *   3. getNetwork()   — verify which network the wallet is on
 *
 * Connect flow:
 *   1. isConnected()     — confirm extension exists
 *   2. requestAccess()   — prompt user to authorize
 *   3. getNetwork()      — read network after auth
 */
export function useFreighter() {
  const [state, setState] = useState<FreighterState>({
    installed: false,
    connected: false,
    address: null,
    network: null,
    loading: true,
    error: null,
  })

  // ── Silent probe on mount (no user prompt) ────────────────────────────
  const checkConnection = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      // Step 1: extension installed?
      const { isConnected: installed, error: installErr } = await isConnected()
      if (installErr || !installed) {
        setState((s) => ({ ...s, installed: false, loading: false }))
        return
      }

      // Step 2: already authorized? (getAddress returns "" if not)
      const { address: addr, error: addrErr } = await getAddress()
      if (addrErr || !addr) {
        setState((s) => ({ ...s, installed: true, connected: false, loading: false }))
        return
      }

      // Step 3: read network
      const { network: net, error: netErr } = await getNetwork()
      if (netErr) {
        setState((s) => ({ ...s, installed: true, connected: true, address: addr, loading: false }))
        return
      }

      setState({
        installed: true,
        connected: true,
        address: addr,
        network: net,
        loading: false,
        error: null,
      })
    } catch (e: any) {
      setState((s) => ({ ...s, loading: false, error: e?.message ?? 'Freighter probe failed' }))
    }
  }, [])

  // ── Explicit connect (prompts user) ───────────────────────────────────
  const connect = useCallback(async (): Promise<string> => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      // Step 1: confirm extension
      const { isConnected: installed, error: installErr } = await isConnected()
      if (installErr || !installed) {
        throw new Error('Freighter extension not installed')
      }

      // Step 2: requestAccess — prompts the user
      const { address: addr, error: accessErr } = await requestAccess()
      if (accessErr) throw new Error(accessErr.message)
      if (!addr) throw new Error('Freighter access denied')

      // Step 3: network
      const { network: net, error: netErr } = await getNetwork()

      setState({
        installed: true,
        connected: true,
        address: addr,
        network: netErr ? null : net,
        loading: false,
        error: null,
      })

      return addr
    } catch (e: any) {
      const msg = e?.message ?? 'Freighter connect failed'
      setState((s) => ({ ...s, loading: false, error: msg }))
      throw e
    }
  }, [])

  // ── Disconnect (local state only — Freighter has no disconnect API) ───
  const disconnect = useCallback(() => {
    setState((s) => ({
      ...s,
      connected: false,
      address: null,
      network: null,
      error: null,
    }))
  }, [])

  // ── Sign a transaction XDR ────────────────────────────────────────────
  const sign = useCallback(
    async (xdr: string, networkPassphrase: string): Promise<string> => {
      if (!state.connected) throw new Error('Freighter not connected')
      const { signedTxXdr, error } = await signTransaction(xdr, { networkPassphrase })
      if (error) throw new Error(error.message)
      return signedTxXdr
    },
    [state.connected],
  )

  // Auto-probe on mount + retry once after 2s (extension may load late)
  useEffect(() => {
    checkConnection()
    const retry = setTimeout(checkConnection, 2000)
    return () => clearTimeout(retry)
  }, [checkConnection])

  return { ...state, connect, disconnect, sign, checkConnection }
}
