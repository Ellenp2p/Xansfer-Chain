import { keccak256, bytesToHex } from 'viem'
import { getAttestationUrl, getChainByDomain, type Mode } from '../config/chains'

export interface IrisMessage {
  message: string | null
  event_nonce: string | null
  attestation: string | null
  cctp_version: number | null
  status: string | null
  forward_state: string | null
  forward_tx_hash: string | null
}

function mapMessage(raw: any): IrisMessage {
  return {
    message: raw?.message ?? null,
    event_nonce: raw?.eventNonce ?? null,
    attestation: raw?.attestation ?? null,
    cctp_version: raw?.cctpVersion ?? null,
    status: raw?.status ?? null,
    forward_state: raw?.forwardState ?? null,
    forward_tx_hash: raw?.forwardTxHash ?? null,
  }
}

/** keccak256("MessageSent(bytes)") — EVM MessageSent event topic. */
const MESSAGE_SENT_TOPIC = keccak256(new TextEncoder().encode('MessageSent(bytes)'))

/** Parse the CCTP `message` bytes from a source chain transaction (v1 flow). */
async function resolveSourceMessage(
  sourceDomain: number,
  sourceTxHash: string,
  mode: Mode,
): Promise<string | null> {
  const chain = getChainByDomain(sourceDomain, mode)
  if (!chain) return null

  if (chain.chain_type === 'aptos') {
    const base = chain.rpc_url.endsWith('/v1') ? chain.rpc_url : `${chain.rpc_url}/v1`
    const res = await fetch(`${base}/transactions/by_hash/${sourceTxHash}`)
    if (!res.ok) return null
    const tx = await res.json()
    for (const evt of tx.events ?? []) {
      if (typeof evt?.type === 'string' && evt.type.endsWith('::message_transmitter::MessageSent')) {
        const msg = evt?.data?.message
        if (typeof msg === 'string' && msg) return msg.startsWith('0x') ? msg : `0x${msg}`
      }
    }
    return null
  }

  if (chain.chain_type === 'sui') {
    const res = await fetch(chain.rpc_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getTransactionBlock',
        params: [sourceTxHash, { showEvents: true }],
      }),
    })
    if (!res.ok) return null
    const json = await res.json()
    const events = json?.result?.events ?? []
    for (const evt of events) {
      if (typeof evt?.type === 'string' && evt.type.endsWith('::message_transmitter::MessageSent')) {
        const parsed = evt?.parsedJson?.message
        if (typeof parsed === 'string' && parsed) {
          return parsed.startsWith('0x') ? parsed : `0x${parsed}`
        }
        if (Array.isArray(parsed)) {
          const bytes = parsed.map((n: unknown) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255)
          if (bytes.length) return `0x${bytesToHex(new Uint8Array(bytes))}`
        }
      }
    }
    return null
  }

  if (chain.chain_type === 'evm') {
    const res = await fetch(chain.rpc_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [sourceTxHash],
      }),
    })
    if (!res.ok) return null
    const j = await res.json()
    for (const log of j?.result?.logs ?? []) {
      if (log?.topics?.[0] === MESSAGE_SENT_TOPIC) {
        const data = String(log?.data ?? '').replace(/^0x/, '')
        // ABI: bytes32 offset, bytes32 length, then bytes
        const len = parseInt(data.slice(64, 128), 16)
        const msg = data.slice(128, 128 + len * 2)
        if (msg) return `0x${msg}`
      }
    }
    return null
  }

  return null
}

/**
 * Query Circle's Iris API for CCTP attestation status of a source transaction.
 * Used directly by the frontend so status tracking works without the backend.
 *
 * v1 chains (Aptos/Sui/EVM-v1) use `GET {base}/attestations/{messageHash}`
 * where the message is parsed from the source transaction. v2 uses
 * `GET {base}/v2/messages/{sourceDomain}?transactionHash=`.
 */
export async function queryIris(
  sourceDomain: number,
  sourceTxHash: string,
  cctpVersion: number,
  mode: Mode,
): Promise<IrisMessage | null> {
  const base = getAttestationUrl(cctpVersion, mode)

  if (cctpVersion === 1) {
    const message = await resolveSourceMessage(sourceDomain, sourceTxHash, mode)
    if (!message) return null
    const hash = keccak256(message as `0x${string}`)
    try {
      const res = await fetch(`${base}/attestations/${hash}`)
      if (!res.ok) return null
      const data = await res.json()
      // v1 /attestations does not echo the message body — attach the parsed one.
      return mapMessage({ ...data, message: data?.message ?? message })
    } catch {
      return null
    }
  }

  const url = `${base}/messages/${sourceDomain}?transactionHash=${sourceTxHash}`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const messages = data?.messages
    if (!Array.isArray(messages) || messages.length === 0) return null
    return mapMessage(messages[0])
  } catch {
    return null
  }
}

export function isAttestationReady(attestation: string | null): boolean {
  return !!attestation && attestation !== 'PENDING' && attestation !== ''
}
