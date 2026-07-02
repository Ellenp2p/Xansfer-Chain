use anyhow::Result;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::Duration;
use tiny_keccak::{Hasher, Keccak};
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::db::models::Transaction;

const IRIS_API_SANDBOX: &str = "https://iris-api-sandbox.circle.com";
const IRIS_API_PROD: &str = "https://iris-api.circle.com";

fn iris_api_base(cctp_version: i64, network_mode: &str) -> String {
    let base = if network_mode == "testnet" { IRIS_API_SANDBOX } else { IRIS_API_PROD };
    if cctp_version == 2 {
        format!("{base}/v2")
    } else {
        base.to_string()
    }
}

#[derive(Debug, Deserialize)]
pub struct MessagesResponse {
    pub messages: Vec<CctpMessage>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CctpMessage {
    pub message: Option<String>,
    #[serde(rename = "eventNonce")]
    pub event_nonce: Option<String>,
    pub attestation: Option<String>,
    #[serde(rename = "cctpVersion")]
    pub cctp_version: Option<i64>,
    pub status: Option<String>,
    #[serde(rename = "forwardState")]
    pub forward_state: Option<String>,
    #[serde(rename = "forwardTxHash")]
    pub forward_tx_hash: Option<String>,
}

pub struct AttestationPoller {
    pool: SqlitePool,
    http: Client,
    tx_notify: broadcast::Sender<String>,
}

impl AttestationPoller {
    pub fn new(pool: SqlitePool, tx_notify: broadcast::Sender<String>) -> Self {
        Self {
            pool,
            http: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("HTTP client"),
            tx_notify,
        }
    }

    pub async fn run(&self) {
        info!("Attestation poller started");
        loop {
            if let Err(e) = self.poll_pending().await {
                error!("Poller error: {e:#}");
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    }

    async fn poll_pending(&self) -> Result<()> {
        let pending: Vec<Transaction> = sqlx::query_as(
            "SELECT * FROM transactions WHERE status IN ('pending', 'attested')"
        )
        .fetch_all(&self.pool)
        .await?;

        for tx in pending {
            match self.check_attestation(&tx).await {
                Ok(true) => {
                    info!("Attestation ready for tx {}", tx.source_tx_hash);
                    let _ = self.tx_notify.send(tx.id.clone());
                }
                Ok(false) => {}
                Err(e) => {
                    warn!("Error checking attestation for {}: {e:#}", tx.source_tx_hash);
                }
            }
        }

        Ok(())
    }

    async fn check_attestation(&self, tx: &Transaction) -> Result<bool> {
        let version = tx.cctp_version;
        let api_base = iris_api_base(version, &tx.network_mode);

        let url = format!(
            "{}/messages/{}?transactionHash={}",
            api_base, tx.source_domain, tx.source_tx_hash
        );

        tracing::debug!("Polling attestation: GET {}", url);

        let resp = self.http.get(&url).send().await?;

        if !resp.status().is_success() {
            return Ok(false);
        }

        let data: MessagesResponse = resp.json().await?;
        let Some(msg) = data.messages.first() else {
            return Ok(false);
        };

        let attestation = match &msg.attestation {
            Some(a) if a != "PENDING" && !a.is_empty() => a.clone(),
            _ => return Ok(false),
        };

        let now = Utc::now().to_rfc3339();

        // Check forwarding state
        let forward_complete = msg.forward_state.as_deref() == Some("COMPLETE");

        let new_status = if forward_complete {
            "complete"
        } else if tx.transfer_type == "forward" {
            "attested"
        } else if tx.transfer_type == "relay" && tx.status == "pending" {
            "attested"
        } else {
            "attested"
        };

        let dest_tx = if forward_complete {
            msg.forward_tx_hash.clone()
        } else {
            None
        };

        sqlx::query(
            "UPDATE transactions SET status = ?, attestation = ?, message = ?, dest_tx_hash = ?, updated_at = ? WHERE id = ?"
        )
        .bind(new_status)
        .bind(&attestation)
        .bind(&msg.message)
        .bind(&dest_tx)
        .bind(&now)
        .bind(&tx.id)
        .execute(&self.pool)
        .await?;

        Ok(true)
    }

    pub async fn check_transaction(&self, source_domain: i64, source_tx_hash: &str, cctp_version: i64, network_mode: &str) -> Result<Option<CctpMessage>> {
        let api_base = iris_api_base(cctp_version, network_mode);

        let url = format!(
            "{}/messages/{}?transactionHash={}",
            api_base, source_domain, source_tx_hash
        );

        tracing::debug!("Lookup attestation: GET {}", url);

        let resp = self.http.get(&url).send().await?;

        if !resp.status().is_success() {
            return Ok(None);
        }

        let data: MessagesResponse = resp.json().await?;
        Ok(data.messages.into_iter().next())
    }

    /// Check on-chain whether a message has been received/claimed on the destination chain.
    /// Calls `isMessageReceived(bytes32 messageHash)` on the MessageTransmitter contract.
    pub async fn check_message_received(
        &self,
        dest_rpc_url: &str,
        message_transmitter: &str,
        message_hex: &str,
    ) -> Result<bool> {
        // Decode message hex to bytes
        let msg_hex = message_hex.strip_prefix("0x").unwrap_or(message_hex);
        let msg_bytes = hex::decode(msg_hex)
            .map_err(|e| anyhow::anyhow!("Invalid message hex: {}", e))?;

        // Compute keccak256(message) for the messageHash parameter
        let msg_hash = keccak256(&msg_bytes);

        // Build eth_call data: selector + padded hash
        // function isMessageReceived(bytes32 messageHash) → selector = keccak256(sig)[0:4]
        let selector = keccak256_selector(b"isMessageReceived(bytes32)");
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&selector);
        calldata.extend_from_slice(&msg_hash);

        let calldata_hex = format!("0x{}", hex::encode(&calldata));

        // JSON-RPC eth_call
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_call",
            "params": [
                {
                    "to": message_transmitter,
                    "data": calldata_hex,
                },
                "latest"
            ],
            "id": 1
        });

        tracing::debug!(
            "check_message_received: POST {} (contract={})",
            dest_rpc_url, message_transmitter
        );

        let resp = self.http.post(dest_rpc_url).json(&body).send().await?;

        if !resp.status().is_success() {
            warn!("eth_call returned HTTP {}", resp.status());
            return Ok(false);
        }

        let rpc_resp: serde_json::Value = resp.json().await?;

        if let Some(error) = rpc_resp.get("error") {
            warn!("eth_call RPC error: {}", error);
            return Ok(false);
        }

        if let Some(result) = rpc_resp.get("result").and_then(|r| r.as_str()) {
            // Result is a 32-byte ABI-encoded bool: 0x...01 = true, 0x...00 = false
            // Just check if last byte is non-zero
            let result_hex = result.strip_prefix("0x").unwrap_or(result);
            if result_hex.len() >= 64 {
                let last_byte = &result_hex[result_hex.len() - 2..];
                return Ok(last_byte != "00");
            }
            // Fallback: check if result is non-zero
            return Ok(result != "0x0000000000000000000000000000000000000000000000000000000000000000");
        }

        Ok(false)
    }
}

/// Compute keccak256 hash of data
fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    let mut output = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut output);
    output
}

/// Compute the first 4 bytes of keccak256(signature) — the Solidity function selector
fn keccak256_selector(signature: &[u8]) -> [u8; 4] {
    let hash = keccak256(signature);
    [hash[0], hash[1], hash[2], hash[3]]
}
