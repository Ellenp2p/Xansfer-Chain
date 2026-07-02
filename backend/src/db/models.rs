use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Transaction {
    pub id: String,
    pub source_domain: i64,
    pub dest_domain: i64,
    pub source_tx_hash: String,
    pub source_address: String,
    pub dest_address: String,
    pub amount: String,
    pub status: String,
    pub cctp_version: i64,
    pub transfer_type: String,
    pub attestation: Option<String>,
    pub message: Option<String>,
    pub dest_tx_hash: Option<String>,
    pub claimed_at: Option<String>,
    pub error_message: Option<String>,
    pub network_mode: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RelayJob {
    pub id: String,
    pub tx_id: String,
    pub status: String,
    pub retry_count: i64,
    pub max_retries: i64,
    pub error_message: Option<String>,
    pub next_retry_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateTransactionRequest {
    pub source_domain: i64,
    pub dest_domain: i64,
    pub source_tx_hash: String,
    pub source_address: String,
    pub dest_address: String,
    pub amount: String,
    pub cctp_version: Option<i64>,
    pub transfer_type: Option<String>,
    pub network_mode: Option<String>,
    pub use_relay: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct LookupRequest {
    pub source_tx_hash: String,
    pub source_domain: i64,
    pub mode: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TransactionStatusResponse {
    pub transaction: Transaction,
    pub attestation_ready: bool,
    pub can_claim: bool,
    pub claimed: bool,
    pub relay_job: Option<RelayJob>,
}

impl Transaction {
    pub fn new(req: &CreateTransactionRequest) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            source_domain: req.source_domain,
            dest_domain: req.dest_domain,
            source_tx_hash: req.source_tx_hash.clone(),
            source_address: req.source_address.clone(),
            dest_address: req.dest_address.clone(),
            amount: req.amount.clone(),
            status: "pending".to_string(),
            cctp_version: req.cctp_version.unwrap_or(2),
            transfer_type: req.transfer_type.clone().unwrap_or_else(|| "standard".to_string()),
            attestation: None,
            message: None,
            dest_tx_hash: None,
            claimed_at: None,
            error_message: None,
            network_mode: req.network_mode.clone().unwrap_or_else(|| "testnet".to_string()),
            created_at: now.clone(),
            updated_at: now,
        }
    }
}
