import { probeBackend } from './api'

type TxUpdate = { type: 'tx_update'; tx_id: string }

let ws: WebSocket | null = null
let started = false
const listeners = new Map<string, Set<(txId: string) => void>>()

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws`)

  ws.onmessage = (event) => {
    try {
      const data: TxUpdate = JSON.parse(event.data)
      if (data.type === 'tx_update') {
        listeners.get('*')?.forEach((cb) => cb(data.tx_id))
        listeners.get(data.tx_id)?.forEach((cb) => cb(data.tx_id))
      }
    } catch {
      // ignore malformed messages
    }
  }

  ws.onclose = () => {
    ws = null
    setTimeout(connect, 5000)
  }
}

export function subscribeTx(txId: string, cb: (txId: string) => void): () => void {
  if (!started) {
    started = true
    // Only open the socket when a backend is actually reachable — standalone
    // static hosting has no /ws endpoint.
    probeBackend().then((up) => {
      if (up) connect()
    })
  }
  if (!listeners.has(txId)) listeners.set(txId, new Set())
  listeners.get(txId)!.add(cb)

  if (!listeners.has('*')) listeners.set('*', new Set())
  listeners.get('*')!.add(cb)

  return () => {
    listeners.get(txId)?.delete(cb)
    listeners.get('*')?.delete(cb)
  }
}
