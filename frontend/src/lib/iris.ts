import { getAttestationUrl, type Mode } from '../config/chains'

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

/**
 * Query Circle's Iris API for CCTP attestation status of a source transaction.
 * Used directly by the frontend so status tracking works without the backend.
 */
export async function queryIris(
  sourceDomain: number,
  sourceTxHash: string,
  cctpVersion: number,
  mode: Mode,
): Promise<IrisMessage | null> {
  const base = getAttestationUrl(cctpVersion, mode)
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
