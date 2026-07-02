export type ChainType = 'evm' | 'stellar' | 'solana' | 'starknet' | 'aptos' | 'sui'

export interface ChainConfig {
  domain: number
  name: string
  chain_id: number | null
  rpc_url: string
  explorer_url: string
  usdc_address: string
  token_messenger_v2: string
  message_transmitter_v2: string
  token_messenger_v1?: string
  message_transmitter_v1?: string
  cctp_versions?: number[]
  chain_type: ChainType
  supports_fast_transfer: boolean
  supports_forwarding: boolean
  block_time_ms: number
  finality_blocks: number
}

export type TransferType = 'standard' | 'fast' | 'forward' | 'relay'

export type TxStatus = 'pending' | 'attested' | 'minting' | 'complete' | 'failed'

export interface Transaction {
  id: string
  source_domain: number
  dest_domain: number
  source_tx_hash: string
  source_address: string
  dest_address: string
  amount: string
  status: TxStatus
  cctp_version: number
  transfer_type: TransferType
  attestation: string | null
  message: string | null
  dest_tx_hash: string | null
  claimed_at?: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface RelayJob {
  id: string
  tx_id: string
  status: string
  retry_count: number
  max_retries: number
  error_message: string | null
  next_retry_at: string | null
  created_at: string
  updated_at: string
}

export interface TransactionStatusResponse {
  transaction: Transaction
  attestation_ready: boolean
  can_claim: boolean
  claimed: boolean
  relay_job: RelayJob | null
}

export interface CreateTransactionRequest {
  source_domain: number
  dest_domain: number
  source_tx_hash: string
  source_address: string
  dest_address: string
  amount: string
  cctp_version?: number
  transfer_type?: TransferType
  use_relay?: boolean
}

export interface LookupResponse {
  transaction: Transaction | null
  circle_status: {
    message: string
    event_nonce: string | null
    attestation: string | null
    cctp_version: number | null
    status: string | null
    forward_state: string | null
    forward_tx_hash: string | null
  } | null
}
