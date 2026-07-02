// CCTP contract addresses — v1 and v2, mainnet vs testnet

// ── v2: Same TokenMessengerV2 / MessageTransmitterV2 across ALL EVM chains ──

export const CCTP_V2 = {
  mainnet: {
    tokenMessenger: '0x28b5a0e9C2308A3d74BE81826939D71BC9371B2e',
    messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D720d9770512A',
    attestationApi: 'https://iris-api.circle.com',
  },
  testnet: {
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    attestationApi: 'https://iris-api-sandbox.circle.com',
  },
} as const

// ── v1: Per-chain TokenMessenger + MessageTransmitter addresses ──────────────

export const CCTP_V1 = {
  mainnet: {
    tokenMessenger: {
      0: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155', // Ethereum
      1: '0x6B25532e1060CE10cc3B0A99e5683b91CDe25000', // Avalanche
      2: '0x2B4069517957735bE00ceE0fadAE88a26365528f', // OP Mainnet
      3: '0x19330d10D9Cc8751218eaf51E8885D05864c2f89', // Arbitrum
      6: '0x1682Ae6375C4E4A97e4B583BC394c861A46d8962', // Base
      7: '0x9f3B8679c73C2Fef8b59B4f3444d4e156319e387', // Polygon PoS
    } as Record<number, string>,
    messageTransmitter: {
      0: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81', // Ethereum
      1: '0x8186359aF5F57FbB40c6b14A5b5941C9Fb33c4eE', // Avalanche
      2: '0x4d41f22cA3881B48B55c77163D26BBe328557a7D', // OP Mainnet
      3: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca', // Arbitrum
      6: '0xAD09780d193884d503182aD4588450C416D6F9D4', // Base
      7: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9', // Polygon PoS
    } as Record<number, string>,
    attestationApi: 'https://iris-api.circle.com',
  },
  testnet: {
    tokenMessenger: {
      0: '0x9f3B8679c73C2Fef8b59B4f3444d4e156319E528', // Sepolia
      1: '0xeb08f243E5d3FCFF26A9E38Aea666c6243d421b4', // Fuji
    } as Record<number, string>,
    messageTransmitter: {
      0: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD', // Sepolia
      1: '0xa9fb1b30a9d03985dF65DdBb7A6a6B63e64EF04c', // Fuji
    } as Record<number, string>,
    attestationApi: 'https://iris-api-sandbox.circle.com',
  },
} as const

// ── Legacy export for backward compat ────────────────────────────────────────

export const CCTP_CONTRACTS = {
  mainnet: {
    tokenMessengerV2: CCTP_V2.mainnet.tokenMessenger,
    messageTransmitterV2: CCTP_V2.mainnet.messageTransmitter,
    attestationApi: CCTP_V2.mainnet.attestationApi,
  },
  testnet: {
    tokenMessengerV2: CCTP_V2.testnet.tokenMessenger,
    messageTransmitterV2: CCTP_V2.testnet.messageTransmitter,
    attestationApi: CCTP_V2.testnet.attestationApi,
  },
} as const

// ── Version-aware helpers ────────────────────────────────────────────────────

type Mode = 'mainnet' | 'testnet'

export interface CctpContractSet {
  tokenMessenger: string
  messageTransmitter: string
}

export function getCctpContracts(domain: number, version: number, mode: Mode): CctpContractSet | null {
  if (version === 2) {
    return {
      tokenMessenger: CCTP_V2[mode].tokenMessenger,
      messageTransmitter: CCTP_V2[mode].messageTransmitter,
    }
  }
  if (version === 1) {
    const tm = CCTP_V1[mode].tokenMessenger[domain]
    const mt = CCTP_V1[mode].messageTransmitter[domain]
    if (!tm || !mt) return null
    return { tokenMessenger: tm, messageTransmitter: mt }
  }
  return null
}

export function getAttestationUrl(version: number, mode: Mode): string {
  const base = mode === 'testnet'
    ? 'https://iris-api-sandbox.circle.com'
    : 'https://iris-api.circle.com'
  return version === 2 ? `${base}/v2` : base
}

export function getSupportedVersions(domain: number, mode: Mode): number[] {
  // v2 is available on all chains
  const versions: number[] = [2]
  // v1 is only on domains that have v1 contracts
  if (CCTP_V1[mode].tokenMessenger[domain]) {
    versions.unshift(1) // [1, 2]
  }
  return versions
}
