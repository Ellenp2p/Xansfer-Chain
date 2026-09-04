import { useParams, Link } from 'react-router-dom'
import { useCctpTransfer } from '../hooks/useCctpTransfer'
import { useAttestationStatus } from '../hooks/useAttestationStatus'
import { useNetworkMode } from '../stores/networkMode'
import { isPlausibleDestTxHash } from '../lib/api'
import { CheckCircle2, Clock, Loader2, AlertCircle, RefreshCw, Send, Search } from 'lucide-react'

const STEPS = ['pending', 'attested', 'complete'] as const

function stepIndex(status: string, claimComplete: boolean) {
  if (claimComplete) return STEPS.length - 1
  const i = STEPS.indexOf(status as typeof STEPS[number])
  return i >= 0 ? i : -1
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`
}

// CCTP message: 116-byte header (version, domains, nonce, sender, recipient,
// destinationCaller) + burn body (version, burnToken, mintRecipient, amount,
// messageSender). Decoded so the user can verify what they are about to sign.
interface DecodedBurnMessage {
  amount: string
  mintRecipient: string
}

function decodeCctpBurnMessage(messageHex: string): DecodedBurnMessage | null {
  try {
    const clean = messageHex.replace(/^0x/, '').toLowerCase()
    // body: 4 (version) + 32 (burnToken) + 32 (mintRecipient) + 32 (amount) + 32 (messageSender)
    if (!/^[0-9a-f]+$/.test(clean) || clean.length < (116 + 4 + 32 + 32 + 32) * 2) return null
    const body = clean.slice(116 * 2)
    const mintRecipient = `0x${body.slice(72, 136)}`
    const amountUnits = BigInt(`0x${body.slice(136, 200)}`)
    return { amount: (Number(amountUnits) / 1_000_000).toString(), mintRecipient }
  } catch {
    return null
  }
}

/** Compare the decoded mint recipient against the recorded destination address. */
function recipientMatches(mintRecipient: string, destAddress: string): boolean {
  const rec = mintRecipient.replace(/^0x/, '').toLowerCase()
  const dest = destAddress.replace(/^0x/i, '').toLowerCase()
  if (dest.length === 64) return rec === dest
  if (dest.length === 40) return rec.startsWith('000000000000000000000000') && rec.endsWith(dest)
  return false
}

export default function TransactionStatus() {
  const { id } = useParams<{ id: string }>()
  const { step: claimStep, error: claimError, claimOnDestination, reset } = useCctpTransfer()
  const { mode } = useNetworkMode()

  // Single fetch source — hook handles all polling
  const { data, isLoading, error, refetch, elapsed, estimatedWait } = useAttestationStatus(
    id ?? null,
    !!id,
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="py-20 text-center">
        <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
        <p className="mb-4 text-red-400">{error || 'Transaction not found'}</p>
        <Link
          to="/lookup"
          className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
        >
          <Search className="h-4 w-4" />
          Lookup manually
        </Link>
      </div>
    )
  }

  const tx = data.transaction
  const destHashOk = !tx.dest_tx_hash || isPlausibleDestTxHash(tx.dest_tx_hash, tx.dest_domain, mode)
  const claimComplete = ((claimStep as string) === 'complete' || data.claimed) && destHashOk
  const si = stepIndex(tx.status, claimComplete)
  const isClaiming = claimStep !== 'idle' && claimStep !== 'error' && claimStep !== 'complete'
  const canShowClaim = data.can_claim && tx.transfer_type !== 'relay' && tx.status !== 'complete' && !data.claimed && !claimComplete && !isClaiming
  const isRelayWaiting = tx.transfer_type === 'relay' && tx.status === 'attested'

  async function handleClaim() {
    if (!tx.attestation || !tx.message || !id) return
    reset()
    await claimOnDestination(tx.dest_domain, tx.attestation, tx.message, tx.cctp_version, id)
    // Refetch status after claim completes
    refetch()
  }

  function getClaimButtonText(): string {
    switch (claimStep) {
      case 'switching-dest-chain': return 'Switching chain...'
      case 'claiming': return 'Confirm claim in wallet...'
      case 'waiting-claim': return 'Claim submitted, waiting for confirmation...'
      case 'complete': return 'Claim complete!'
      case 'error': return 'Claim failed — try again'
      default: return 'Claim on Destination'
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Step indicator */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
        <h2 className="mb-4 sm:mb-6 text-lg font-semibold">Transfer Status</h2>
        <div className="flex items-center justify-between">
          {STEPS.map((step, i) => (
            <div key={step} className="flex flex-1 items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-full border-2 ${
                    i < si
                      ? 'border-green-500 bg-green-500/20 text-green-400'
                      : i === si
                        ? 'border-brand-500 bg-brand-500/20 text-brand-400'
                        : 'border-gray-700 bg-gray-800 text-gray-600'
                  }`}
                >
                  {i < si || (i === si && claimComplete) ? (
                    <CheckCircle2 className="h-4 w-4 sm:h-5 sm:w-5" />
                  ) : i === si && tx.status !== 'failed' ? (
                    <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin" />
                  ) : (
                    <Clock className="h-4 w-4 sm:h-5 sm:w-5" />
                  )}
                </div>
                <span className="mt-1.5 sm:mt-2 text-[10px] sm:text-xs capitalize text-gray-400">{step}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`mx-1 sm:mx-2 h-0.5 flex-1 ${
                    i < si ? 'bg-green-500' : 'bg-gray-700'
                  }`}
                />
              )}
            </div>
          ))}
        </div>
        {tx.status === 'failed' && (
          <div className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 break-words">
            <AlertCircle className="mr-2 inline h-4 w-4" />
            {tx.error_message || 'Transaction failed'}
          </div>
        )}
        {/* Waiting indicator with elapsed / estimated time */}
        {(tx.status === 'pending' || tx.status === 'attested') && !claimComplete && !data.claimed && estimatedWait && (
          <div className="mt-4 flex items-center gap-3 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin text-brand-400 shrink-0" />
            <span>
              Elapsed {formatSeconds(elapsed)}
              {elapsed < estimatedWait && (
                <> · Estimated ~{formatSeconds(estimatedWait)}</>
              )}
              {elapsed >= estimatedWait && (
                <> · Waiting for attestation...</>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Claim button */}
      {claimComplete && (
        <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 text-green-400 shrink-0" />
            <div>
              <h2 className="text-lg font-semibold text-green-400">Transfer Complete</h2>
              <p className="text-sm text-gray-400">USDC has been minted on the destination chain.</p>
            </div>
          </div>
        </div>
      )}
      {tx.status === 'complete' && !destHashOk && (
        <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-yellow-400 shrink-0" />
            <div>
              <h2 className="text-lg font-semibold text-yellow-400">Completion Unverified</h2>
              <p className="text-sm text-gray-400 break-words">
                The server reports this transfer as complete, but the destination transaction hash is missing or
                malformed. Verify the destination balance before assuming the funds arrived.
              </p>
            </div>
          </div>
        </div>
      )}
      {(canShowClaim || isClaiming) && !claimComplete && (
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
          <h2 className="mb-3 text-lg font-semibold">Claim USDC</h2>
          <p className="mb-4 text-sm text-gray-400">
            Your USDC has been attested. Switch to the destination chain and call receiveMessage to mint USDC.
          </p>
          {tx.message && (() => {
            const decoded = decodeCctpBurnMessage(tx.message)
            if (!decoded) return null
            const amountOk = decoded.amount === tx.amount
            const recipientOk = recipientMatches(decoded.mintRecipient, tx.dest_address)
            return (
              <div className="mb-4 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2 text-xs">
                <div className="flex justify-between gap-3 py-0.5">
                  <span className="text-gray-500">Message Amount</span>
                  <span className={amountOk ? 'text-gray-300' : 'text-yellow-400'}>
                    {decoded.amount} USDC{!amountOk && ' (differs from recorded amount)'}
                  </span>
                </div>
                <div className="flex justify-between gap-3 py-0.5">
                  <span className="text-gray-500 shrink-0">Mint Recipient</span>
                  <span className={`font-mono truncate ${recipientOk ? 'text-gray-300' : 'text-yellow-400'}`}>
                    {decoded.mintRecipient}{!recipientOk && ' (!)'}
                  </span>
                </div>
                {(!amountOk || !recipientOk) && (
                  <p className="mt-1 text-yellow-400">
                    The signed message does not match this transfer's records — do not claim unless you verified it yourself.
                  </p>
                )}
              </div>
            )
          })()}
          {claimError && (
            <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400 break-words">
              {claimError}
            </div>
          )}
          <button
            onClick={handleClaim}
            disabled={isClaiming}
            className="w-full rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {(claimStep === 'switching-dest-chain' || claimStep === 'claiming' || claimStep === 'waiting-claim') && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {claimStep === 'complete' ? (
              <CheckCircle2 className="h-4 w-4 text-green-400" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {getClaimButtonText()}
          </button>
        </div>
      )}

      {/* Relay waiting message */}
      {isRelayWaiting && (
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
          <h2 className="mb-3 text-lg font-semibold">Relay in Progress</h2>
          <p className="text-sm text-gray-400">
            Your transaction has been attested. The relay server will submit the destination transaction shortly.
          </p>
          <div className="mt-3 flex items-center gap-2 text-sm text-brand-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for relay...
          </div>
        </div>
      )}

      {/* Details */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Details</h2>
          <button
            onClick={() => refetch()}
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <dl className="mt-4 space-y-3 text-sm">
          <Row label="Source Tx" value={tx.source_tx_hash} mono />
          <Row label="Amount" value={`${tx.amount} USDC`} />
          <Row label="CCTP Version" value={`v${tx.cctp_version}`} />
          <Row label="Transfer Type" value={tx.transfer_type} />
          <Row label="Source Domain" value={String(tx.source_domain)} />
          <Row label="Dest Domain" value={String(tx.dest_domain)} />
          {tx.dest_tx_hash && <Row label="Dest Tx" value={tx.dest_tx_hash} mono />}
          {tx.claimed_at && <Row label="Claimed At" value={new Date(tx.claimed_at).toLocaleString()} />}
          {tx.attestation && (
            <Row label="Attestation" value={`${tx.attestation.slice(0, 32)}...`} mono />
          )}
          <Row label="Created" value={new Date(tx.created_at).toLocaleString()} />
        </dl>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500 shrink-0">{label}</dt>
      <dd className={`text-gray-300 min-w-0 truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
