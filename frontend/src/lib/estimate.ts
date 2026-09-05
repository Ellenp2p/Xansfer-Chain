import { getChainByDomain, type Mode } from '../config/chains'
import type { TransferType } from '../types'

/**
 * Estimated attestation wait times in seconds, by source chain + CCTP version + speed.
 * Source: Circle CCTP documentation (v1 & v2 finality tables), 2025. Values are
 * mainnet attestation times unless noted otherwise.
 */
const ESTIMATED_WAIT_BY_CHAIN: Record<string, Record<number, { fast?: number; standard: number }>> = {
  // ── CCTP v1 ──────────────────────────────────────────────────────
  ethereum:    { 1: { standard: 1020 } },          // ~13-19min → 17min avg
  avalanche:   { 1: { standard: 8 },  2: { fast: 8, standard: 8 } },
  optimism:    { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },
  arbitrum:    { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },
  noble:       { 1: { standard: 20 } },
  base:        { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },
  polygon:     { 1: { standard: 98 },  2: { fast: 8, standard: 8 } },
  solana:      { 1: { standard: 25 },  2: { fast: 8, standard: 25 } },
  sui:         { 1: { standard: 8 } },
  aptos:       { 1: { standard: 8 }, 2: { fast: 8, standard: 8 } },
  unichain:    { 1: { standard: 1020 }, 2: { fast: 8, standard: 1020 } },

  // ── CCTP v2 additional chains ────────────────────────────────────
  linea:       { 2: { fast: 8, standard: 36000 } },   // 6-32h → 10h avg
  starknet:    { 2: { fast: 20, standard: 21600 } },   // 4-8h → 6h avg
  ink:         { 2: { fast: 8, standard: 1800 } },     // ~30min
  morph:       { 2: { fast: 8, standard: 1500 } },     // ~20-30min
  worldchain:  { 2: { fast: 8, standard: 1020 } },
  plume:       { 2: { fast: 8, standard: 1020 } },
  stellar:     { 2: { standard: 5 } },
  bsc:         { 2: { standard: 2 } },
  sonic:       { 2: { standard: 8 } },
  sei:         { 2: { standard: 5 } },
  monad:       { 2: { standard: 5 } },
  hyperliquid: { 2: { standard: 5 } },
  xdc:         { 2: { standard: 10 } },
  cronos:      { 2: { standard: 1 } },
  arc:         { 2: { standard: 1 } },
  injective:   { 2: { standard: 1 } },
  pharos:      { 2: { standard: 7 } },
  codex:       { 2: { fast: 8, standard: 1020 } },
  edge:        { 2: { fast: 8, standard: 1140 } },
}

/** CCTP domain number → canonical chain key for ESTIMATED_WAIT_BY_CHAIN. */
const DOMAIN_TO_CHAIN: Record<number, string> = {
  0: 'ethereum',
  1: 'avalanche',
  2: 'optimism',
  3: 'arbitrum',
  4: 'noble',
  5: 'solana',
  6: 'base',
  7: 'polygon',
  8: 'sui',
  9: 'aptos',
  10: 'unichain',
  11: 'linea',
  12: 'codex',
  13: 'sonic',
  14: 'worldchain',
  15: 'monad',
  16: 'sei',
  17: 'bsc',
  18: 'xdc',
  19: 'hyperliquid',
  21: 'ink',
  22: 'plume',
  25: 'starknet',
  26: 'arc',
  27: 'stellar',
  28: 'edge',
  29: 'injective',
  30: 'morph',
  31: 'pharos',
  32: 'cronos',
}

/**
 * Estimated seconds from a confirmed source burn to Circle attestation,
 * based on source chain finality. Covers attestation only — not the
 * destination mint.
 */
export function lookupEstimatedWait(
  sourceDomain: number | undefined,
  cctpVersion: number | undefined,
  isFast: boolean,
): number {
  const key = sourceDomain != null ? DOMAIN_TO_CHAIN[sourceDomain] : undefined
  const ver = cctpVersion ?? (isFast ? 2 : 1)
  if (key) {
    const chain = ESTIMATED_WAIT_BY_CHAIN[key]?.[ver]
    if (chain) return isFast ? (chain.fast ?? chain.standard) : chain.standard
  }
  // Fallback: fast → 30s, standard → 18min
  return isFast ? 30 : 1080
}

/** One destination block — the mint transaction needs it to confirm. */
function destMintSeconds(destDomain: number, mode: Mode): number {
  const ms = getChainByDomain(destDomain, mode)?.block_time_ms ?? 2000
  return Math.max(1, Math.ceil(ms / 1000))
}

/**
 * Total estimated seconds from a confirmed source burn to the destination
 * mint being claimable/confirmed: Circle attestation wait + one destination
 * block. Shown pre-flight in the transfer form.
 */
export function estimateTransferSeconds(opts: {
  sourceDomain: number
  destDomain: number
  cctpVersion: number
  transferType: TransferType
  mode: Mode
}): number {
  const isFast = opts.transferType === 'fast'
  return (
    lookupEstimatedWait(opts.sourceDomain, opts.cctpVersion, isFast) +
    destMintSeconds(opts.destDomain, opts.mode)
  )
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`
}
