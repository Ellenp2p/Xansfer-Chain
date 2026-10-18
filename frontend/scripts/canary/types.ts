/**
 * Runtime types shared by the canary executor and the per-chain drivers.
 *
 * Everything here is testnet-only. Drivers receive already-resolved config
 * (RPC URLs, contract addresses) and a secret; they never read `config/chains.json`
 * themselves, so the same driver can be unit-tested against fixtures.
 */

export type Mode = 'testnet'

export interface DriverChain {
  domain: number
  name: string
  chain_type: string
  chain_id: number | null
  cctp_versions: number[]
  usdc_decimals: number
  rpc_url: string
  usdc_address: string
  usdc_sac?: string
}

export interface CctpVersionConfig {
  token_messenger: Record<string, string>
  message_transmitter: Record<string, string>
  attestation_api: string
  cctp_extensions?: Record<string, string>
  stablecoin_handler?: Record<string, string>
}

export interface TestnetConfig {
  mode: Mode
  v1: CctpVersionConfig
  v2: CctpVersionConfig
}

export interface DriverContext {
  config: TestnetConfig
  log: (message: string) => void
}

export interface BurnRequest {
  chain: DriverChain
  version: number
  /** Amount in the source chain's USDC units (not micro-USDC). */
  amountUnits: bigint
  destDomain: number
  destChain: DriverChain
  /** Canary wallet address on the destination chain. */
  destAddress: string
  fast: boolean
  secret: string
}

export interface ClaimRequest {
  chain: DriverChain
  version: number
  message: string
  attestation: string
  secret: string
}

export interface CanaryDriver {
  readonly type: string
  readonly nativeSymbol: string
  readonly nativeDecimals: number
  readonly defaultMinNative: bigint

  /** Derive the wallet address that will sign burns/claims on this chain. */
  address(secret: string): string
  nativeBalance(chain: DriverChain, address: string): Promise<bigint>
  usdcBalance(chain: DriverChain, address: string): Promise<bigint>

  burn(ctx: DriverContext, req: BurnRequest): Promise<string>
  claim(ctx: DriverContext, req: ClaimRequest): Promise<string>
  /** Wait until the source transaction is confirmed (default: driver sleeps/polls). */
  waitForBurn?(chain: DriverChain, txHash: string): Promise<void>
}
