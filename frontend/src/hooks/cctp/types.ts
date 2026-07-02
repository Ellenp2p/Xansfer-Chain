import type { ChainConfig } from '../../types'

export interface SourceBurnParams {
  chainConfig: ChainConfig
  amount: string
  destDomain: number
  destAddress: string
  destChainType?: string
  cctpVersion: number
  transferType: string
}

export interface ClaimParams {
  destDomain: number
  message: string
  attestation: string
  cctpVersion: number
  destChainType?: string
}

export interface ChainAdapter {
  switchChain(domain: number): Promise<void>
  approveUsdc(chainConfig: ChainConfig, amount: string, cctpVersion?: number): Promise<void>
  burnUsdc(params: SourceBurnParams): Promise<string>
  waitForSourceTx(txHash: string, chainConfig: ChainConfig): Promise<any>
  claimOnDest(params: ClaimParams): Promise<string>
}
