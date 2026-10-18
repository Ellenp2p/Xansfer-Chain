/** Shared destination-address encoding for cross-chain canary burns. */

import { buildCctpForwarderHookDataBytes, normalizeMintRecipient } from '../../src/lib/cctpEncoding'

export const STELLAR_CCTP_FORWARDER: Record<string, string> = {
  testnet: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
  mainnet: 'CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T',
}

/** Stellar C-address (contract) or G-address (account). */
export function isStellarContract(address: string): boolean {
  return address.startsWith('C') && address.length === 56
}

export function isStellarAccount(address: string): boolean {
  return (address.startsWith('G') || address.startsWith('M')) && address.length === 56
}

/** USDC token account (ATA) for a Solana owner. */
export function solanaUsdcAta(owner: string, usdcMint: string): string {
  // Avoid importing @solana/web3.js at module load for non-Solana routes.
  const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js')
  const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(usdcMint).toBuffer()],
    ATA_PROGRAM,
  )
  return ata.toBase58()
}

/** USDC token account as the 32-byte hex value CCTP puts in `mintRecipient`. */
export function solanaUsdcAtaHex(owner: string, usdcMint: string): string {
  const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js')
  return normalizeMintRecipient(new PublicKey(solanaUsdcAta(owner, usdcMint)).toBuffer().toString('hex'))
}

/** CCTP mint recipient for every non-Stellar destination. */
export function bytes32(address: string): string {
  return normalizeMintRecipient(address)
}

/** Raw hook data for a Stellar G-address reached through CctpForwarder. */
export function buildHookDataForStellar(forwardRecipient: string): Uint8Array {
  return buildCctpForwarderHookDataBytes(forwardRecipient)
}
