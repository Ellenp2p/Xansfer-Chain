import { aptosDriver } from './aptos'
import { evmDriver } from './evm'
import { solanaDriver } from './solana'
import { starknetDriver } from './starknet'
import { stellarDriver } from './stellar'
import { suiDriver } from './sui'
import type { CanaryDriver } from './types'

/**
 * Every testnet chain type the canary can execute on. `canaryPlan.CANARY_DRIVER_TYPES`
 * must list the same names; the matrix uses it to decide which routes are real.
 */
export const DRIVERS: Record<string, CanaryDriver> = {
  evm: evmDriver,
  aptos: aptosDriver,
  sui: suiDriver,
  stellar: stellarDriver,
  solana: solanaDriver,
  starknet: starknetDriver,
}

export function driverFor(chainType: string): CanaryDriver {
  const driver = DRIVERS[chainType]
  if (!driver) throw new Error(`no canary driver for chain type "${chainType}"`)
  return driver
}
