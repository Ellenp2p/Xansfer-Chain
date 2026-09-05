import type { Mode } from '../config/chains'

// ── USDC amount handling ────────────────────────────────────────────────────
// parseFloat-based conversion truncates (0.29 * 1e6 → 289999.99… → 289999)
// and silently accepts exponent notation (1e3). All amount math goes through
// string → BigInt conversion instead.

export const USDC_DECIMALS = 6
const USDC_UNITS_PER_COIN = 1_000_000n

/** Strict validation for user-typed amounts: plain decimal, up to 6 fraction digits, > 0. */
export function getUsdcAmountError(amount: string): string | null {
  const trimmed = amount.trim()
  if (!trimmed) return 'Amount is required'
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 'Amount must be a plain decimal number (e.g. 12.5)'
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return 'USDC supports at most 6 decimal places'
  const units = parseUsdcUnits(trimmed)
  if (units <= 0n) return 'Amount must be greater than 0'
  return null
}

/** Exact string → bigint conversion. Throws on malformed input; callers in the
 *  adapters can rely on it because the form validates first. */
export function parseUsdcUnits(amount: string): bigint {
  const trimmed = amount.trim()
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed)
  if (!match) throw new Error(`Invalid USDC amount: "${amount}"`)
  const whole = BigInt(match[1])
  const fraction = BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0')
  return whole * USDC_UNITS_PER_COIN + fraction
}

// ── Circle Iris fee API ─────────────────────────────────────────────────────
// GET {base}/v2/burn/USDC/fees/{srcDomain}/{dstDomain} returns entries of
// { finalityThreshold, minimumFee } where minimumFee is in BASIS POINTS of the
// burn amount. maxFee (in 6-decimal USDC units) = amount * bps / 10_000.
// There must be exactly one conversion path — see audit item 5.

export function circleIrisFeeBase(mode: Mode): string {
  return mode === 'testnet' ? 'https://iris-api-sandbox.circle.com' : 'https://iris-api.circle.com'
}

const FEE_TIMEOUT_MS = 10_000

/**
 * Fetch the Circle fee for a given finality threshold and convert bps → USDC units.
 * Throws on network/timeout failure or invalid payload — a missing fee must not
 * silently fall back to maxFee=0, which reverts fast burns (audit item 19).
 * Returns 0n only when the API answers but has no fee for this threshold.
 */
export async function fetchCircleMaxFee(opts: {
  mode: Mode
  srcDomain: number
  destDomain: number
  finalityThreshold: number
  amountUnits: bigint
}): Promise<bigint> {
  const { mode, srcDomain, destDomain, finalityThreshold, amountUnits } = opts
  const url = `${circleIrisFeeBase(mode)}/v2/burn/USDC/fees/${srcDomain}/${destDomain}`

  let resp: Response
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(FEE_TIMEOUT_MS) })
  } catch (e) {
    throw new Error(`Failed to fetch Circle fee (network): ${(e as Error).message}`)
  }
  if (!resp.ok) throw new Error(`Failed to fetch Circle fee: HTTP ${resp.status}`)

  const data: unknown = await resp.json()
  if (!Array.isArray(data)) throw new Error('Unexpected Circle fee API response')

  const entry = (data as Array<{ finalityThreshold?: number; minimumFee?: number }>).find(
    (f) => f?.finalityThreshold === finalityThreshold && typeof f?.minimumFee === 'number',
  )
  if (!entry) return 0n

  const bps = entry.minimumFee!
  if (bps <= 0) return 0n
  return (amountUnits * BigInt(Math.round(bps))) / 10_000n
}
