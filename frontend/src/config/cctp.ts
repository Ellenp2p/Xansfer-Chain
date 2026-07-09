// CCTP contract addresses — loaded from config/chains.json with fallback to defaults.

import { DEFAULT_CCTP } from './defaults'
import type { Mode } from './chains'

// Static import of the shared JSON config.
import configJson from '../../../config/chains.json'

type ResolvableString = string | { env?: string; template?: string }

function resolveString(value: ResolvableString): string {
  if (typeof value === 'string') return value

  if ('env' in value && value.env) {
    const envValue = import.meta.env[value.env]
    if (!envValue) {
      console.warn(`[cctp-config] Environment variable ${value.env} is not set`)
      return ''
    }
    return String(envValue)
  }

  if ('template' in value && value.template) {
    return value.template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, varName) => {
      const viteVarName = varName.startsWith('VITE_') ? varName : `VITE_${varName}`
      const envValue = import.meta.env[viteVarName]
      if (!envValue) {
        console.warn(`[cctp-config] Environment variable ${viteVarName} is not set for template`)
        return ''
      }
      return String(envValue)
    })
  }

  return ''
}

function isValidConfig(value: unknown): value is { version: number; modes: Record<string, { cctp: unknown }> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof (value as any).version === 'number' &&
    'modes' in value &&
    typeof (value as any).modes === 'object' &&
    (value as any).modes !== null
  )
}

function getCctpForMode(mode: Mode) {
  if (!isValidConfig(configJson)) {
    return DEFAULT_CCTP[mode]
  }

  const modeConfig = (configJson as any).modes[mode]
  if (!modeConfig || !modeConfig.cctp) {
    return DEFAULT_CCTP[mode]
  }

  return modeConfig.cctp
}

export interface CctpContractSet {
  tokenMessenger: string
  messageTransmitter: string
}

export function getCctpContracts(domain: number, version: number, mode: Mode): CctpContractSet | null {
  const cctp = getCctpForMode(mode)
  if (version === 2) {
    const domainKey = String(domain)
    const tokenMessenger = cctp.v2.token_messenger_domains?.[domainKey]
      ?? cctp.v2.token_messenger
    const messageTransmitter = cctp.v2.message_transmitter_domains?.[domainKey]
      ?? cctp.v2.message_transmitter
    return {
      tokenMessenger: resolveString(tokenMessenger),
      messageTransmitter: resolveString(messageTransmitter),
    }
  }
  if (version === 1 && cctp.v1) {
    const tm = cctp.v1.token_messenger[domain]
    const mt = cctp.v1.message_transmitter[domain]
    if (!tm || !mt) return null
    return {
      tokenMessenger: resolveString(tm),
      messageTransmitter: resolveString(mt),
    }
  }
  return null
}

export function getAttestationUrl(version: number, mode: Mode): string {
  const cctp = getCctpForMode(mode)
  const base = version === 2
    ? resolveString(cctp.v2.attestation_api)
    : resolveString(cctp.v1?.attestation_api ?? cctp.v2.attestation_api)
  return version === 2 ? `${base}/v2` : base
}

export function getSupportedVersions(domain: number, mode: Mode): number[] {
  const cctp = getCctpForMode(mode)
  const versions: number[] = [2]
  if (cctp.v1?.token_messenger[domain]) {
    versions.unshift(1)
  }
  return versions
}

// ── Legacy exports for backward compat ──────────────────────────────────────

export const CCTP_V2 = DEFAULT_CCTP.mainnet.v2
export const CCTP_V1 = DEFAULT_CCTP.mainnet.v1

export const CCTP_CONTRACTS = {
  mainnet: {
    tokenMessengerV2: DEFAULT_CCTP.mainnet.v2.tokenMessenger,
    messageTransmitterV2: DEFAULT_CCTP.mainnet.v2.messageTransmitter,
    attestationApi: DEFAULT_CCTP.mainnet.v2.attestationApi,
  },
  testnet: {
    tokenMessengerV2: DEFAULT_CCTP.testnet.v2.tokenMessenger,
    messageTransmitterV2: DEFAULT_CCTP.testnet.v2.messageTransmitter,
    attestationApi: DEFAULT_CCTP.testnet.v2.attestationApi,
  },
} as const
