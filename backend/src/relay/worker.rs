use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::chains::registry::ChainRegistry;
use crate::chains::ChainType;
use crate::db::models::{RelayJob, Transaction};
use crate::relay::{
    aptos_submitter, evm_submitter::{EvmKey, EvmSubmitter},
    signer::RelaySigner, solana_submitter, stellar_submitter, sui_submitter,
};

pub struct RelayWorker {
    pool: SqlitePool,
    signer: RelaySigner,
    chains: ChainRegistry,
    tx_notify: broadcast::Receiver<String>,
}

impl RelayWorker {
    pub fn new(
        pool: SqlitePool,
        signer: RelaySigner,
        chains: ChainRegistry,
        tx_notify: broadcast::Receiver<String>,
    ) -> Self {
        Self {
            pool,
            signer,
            chains,
            tx_notify,
        }
    }

    pub async fn run(&mut self) {
        info!("Relay worker started");

        loop {
            tokio::select! {
                Ok(tx_id) = self.tx_notify.recv() => {
                    if let Err(e) = self.handle_notification(&tx_id).await {
                        error!("Relay handler error for {tx_id}: {e:#}");
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(10)) => {
                    if let Err(e) = self.process_pending_jobs().await {
                        error!("Relay job processor error: {e:#}");
                    }
                }
            }
        }
    }

    async fn handle_notification(&self,
        tx_id: &str,
    ) -> Result<()> {
        let tx: Option<Transaction> = sqlx::query_as("SELECT * FROM transactions WHERE id = ?")
            .bind(tx_id)
            .fetch_optional(&self.pool)
            .await?;

        let Some(tx) = tx else { return Ok(()) };

        if tx.transfer_type != "relay" || tx.status != "attested" {
            return Ok(());
        }

        let dest_chain = self.chains.get(tx.dest_domain);
        let chain_type = dest_chain.map(|c| &c.chain_type).cloned().unwrap_or(ChainType::Evm);

        if !self.signer.has_key_for_domain(tx.dest_domain, &chain_type) {
            warn!("No relay key for domain {} ({:?}), skipping", tx.dest_domain, chain_type);
            return Ok(());
        }

        let job_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();

        sqlx::query(
            "INSERT INTO relay_jobs (id, tx_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)"
        )
        .bind(&job_id)
        .bind(tx_id)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        info!("Created relay job {job_id} for tx {}", tx.source_tx_hash);

        // Update transaction status
        sqlx::query("UPDATE transactions SET status = 'minting', updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(tx_id)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn process_pending_jobs(&self) -> Result<()> {
        let jobs: Vec<RelayJob> = sqlx::query_as(
            "SELECT * FROM relay_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10"
        )
        .fetch_all(&self.pool)
        .await?;

        for job in jobs {
            // Re-fetch transaction state in case it was already claimed/failed externally
            let tx: Option<Transaction> = sqlx::query_as("SELECT * FROM transactions WHERE id = ?")
                .bind(&job.tx_id)
                .fetch_optional(&self.pool)
                .await?;

            if let Some(tx) = tx {
                if tx.status == "complete" || tx.status == "failed" {
                    let now = Utc::now().to_rfc3339();
                    sqlx::query("UPDATE relay_jobs SET status = ?, updated_at = ? WHERE id = ?")
                        .bind(if tx.status == "complete" { "complete" } else { "failed" })
                        .bind(&now)
                        .bind(&job.id)
                        .execute(&self.pool)
                        .await?;
                    continue;
                }
            }

            if let Err(e) = self.execute_relay(&job).await {
                warn!("Relay job {} failed: {e:#}", job.id);
                self.handle_failure(&job, &e.to_string()).await?;
            }
        }

        Ok(())
    }

    async fn execute_relay(&self, job: &RelayJob) -> Result<()> {
        let tx: Transaction = sqlx::query_as("SELECT * FROM transactions WHERE id = ?")
            .bind(&job.tx_id)
            .fetch_one(&self.pool)
            .await?;

        let message = tx
            .message
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No message"))?;
        let attestation = tx
            .attestation
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No attestation"))?;

        let dest_chain = self
            .chains
            .get(tx.dest_domain)
            .ok_or_else(|| anyhow::anyhow!("Unknown destination domain {}", tx.dest_domain))?;

        info!(
            "Executing relay for tx {} on domain {} ({:?})",
            tx.source_tx_hash, tx.dest_domain, dest_chain.chain_type
        );

        let dest_tx_hash = match dest_chain.chain_type {
            ChainType::Evm => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for destination domain {}", tx.dest_domain))?;
                let chain_id = dest_chain.chain_id.ok_or_else(|| {
                    anyhow::anyhow!("EVM destination domain {} missing chain_id", tx.dest_domain)
                })?;
                let message_transmitter = self
                    .chains
                    .get_message_transmitter(tx.dest_domain, &tx.network_mode, tx.cctp_version)
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "No message transmitter for destination domain {}",
                            tx.dest_domain
                        )
                    })?;
                let key: &EvmKey = self
                    .signer
                    .evm_key(tx.dest_domain)
                    .ok_or_else(|| anyhow::anyhow!("No EVM relay key for domain {}", tx.dest_domain))?;

                let submitter = EvmSubmitter::new(rpc_url, chain_id, message_transmitter, key.clone());
                submitter
                    .submit_receive_message(message, attestation, dest_chain.block_time_ms)
                    .await?
            }
            ChainType::Solana => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for Solana domain {}", tx.dest_domain))?;
                let message_transmitter = std::env::var("SOLANA_MESSAGE_TRANSMITTER_V2")
                    .unwrap_or_else(|_| "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC".into());
                let token_messenger_minter = std::env::var("SOLANA_TOKEN_MESSENGER_MINTER_V2")
                    .unwrap_or_else(|_| "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe".into());
                let key = self
                    .signer
                    .solana_key(tx.dest_domain)
                    .ok_or_else(|| anyhow::anyhow!("No Solana relay key for domain {}", tx.dest_domain))?;

                solana_submitter::submit_receive_message(
                    &rpc_url,
                    &message_transmitter,
                    &token_messenger_minter,
                    &dest_chain.usdc_address,
                    key,
                    message,
                    attestation,
                    &tx.dest_address,
                    tx.source_domain,
                )
                .await?
            }
            ChainType::Stellar => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for Stellar domain {}", tx.dest_domain))?;
                let message_transmitter = self
                    .chains
                    .get_message_transmitter(tx.dest_domain, &tx.network_mode, tx.cctp_version)
                    .ok_or_else(|| anyhow::anyhow!("No message transmitter for Stellar domain {}", tx.dest_domain))?;
                let key = self
                    .signer
                    .stellar_key()
                    .ok_or_else(|| anyhow::anyhow!("No Stellar relay key"))?;

                stellar_submitter::submit_receive_message(
                    &rpc_url,
                    &message_transmitter,
                    None,
                    key,
                    message,
                    attestation,
                )
                .await?
            }
            ChainType::Sui => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for Sui domain {}", tx.dest_domain))?;
                let message_transmitter_package = std::env::var("SUI_MESSAGE_TRANSMITTER_PACKAGE")
                    .map_err(|_| anyhow::anyhow!("SUI_MESSAGE_TRANSMITTER_PACKAGE not set"))?;
                let token_messenger_minter_package = std::env::var("SUI_TOKEN_MESSENGER_MINTER_PACKAGE")
                    .map_err(|_| anyhow::anyhow!("SUI_TOKEN_MESSENGER_MINTER_PACKAGE not set"))?;
                let message_transmitter_state = std::env::var("SUI_MESSAGE_TRANSMITTER_STATE")
                    .map_err(|_| anyhow::anyhow!("SUI_MESSAGE_TRANSMITTER_STATE not set"))?;
                let token_messenger_minter_state = std::env::var("SUI_TOKEN_MESSENGER_MINTER_STATE")
                    .map_err(|_| anyhow::anyhow!("SUI_TOKEN_MESSENGER_MINTER_STATE not set"))?;
                let key = self
                    .signer
                    .sui_key(tx.dest_domain)
                    .ok_or_else(|| anyhow::anyhow!("No Sui relay key for domain {}", tx.dest_domain))?;

                sui_submitter::submit_receive_message(
                    &rpc_url,
                    &message_transmitter_package,
                    &token_messenger_minter_package,
                    &message_transmitter_state,
                    &token_messenger_minter_state,
                    key,
                    message,
                    attestation,
                )
                .await?
            }
            ChainType::Aptos => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for Aptos domain {}", tx.dest_domain))?;
                let message_transmitter = std::env::var("APTOS_MESSAGE_TRANSMITTER")
                    .unwrap_or_else(|_| "0x081e86cebf457a0c6004f35bd648a2794698f52e0dde09a48619dcd3d4cc23d9".into());
                let token_messenger_minter = std::env::var("APTOS_TOKEN_MESSENGER_MINTER")
                    .unwrap_or_else(|_| "0x5f9b937419dda90aa06c1836b7847f65bbbe3f1217567758dc2488be31a477b9".into());
                let key = self
                    .signer
                    .aptos_key(tx.dest_domain)
                    .ok_or_else(|| anyhow::anyhow!("No Aptos relay key for domain {}", tx.dest_domain))?;

                aptos_submitter::submit_receive_message(
                    &rpc_url,
                    &message_transmitter,
                    &token_messenger_minter,
                    key,
                    message,
                    attestation,
                )
                .await?
            }
            ChainType::Starknet => {
                return Err(anyhow::anyhow!(
                    "Starknet relay not yet implemented (domain {})",
                    tx.dest_domain
                ));
            }
        };

        let now = Utc::now().to_rfc3339();

        // Update transaction as complete
        sqlx::query(
            "UPDATE transactions SET status = 'complete', dest_tx_hash = ?, claimed_at = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&dest_tx_hash)
        .bind(&now)
        .bind(&now)
        .bind(&tx.id)
        .execute(&self.pool)
        .await?;

        // Update relay job as complete
        sqlx::query("UPDATE relay_jobs SET status = 'complete', updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&job.id)
            .execute(&self.pool)
            .await?;

        info!(
            "Relay complete for tx {}, dest hash: {}",
            tx.source_tx_hash, dest_tx_hash
        );

        Ok(())
    }

    async fn handle_failure(&self, job: &RelayJob, error: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();

        if job.retry_count + 1 >= job.max_retries {
            sqlx::query(
                "UPDATE relay_jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?"
            )
            .bind(error)
            .bind(&now)
            .bind(&job.id)
            .execute(&self.pool)
            .await?;

            sqlx::query(
                "UPDATE transactions SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?"
            )
            .bind(error)
            .bind(&now)
            .bind(&job.tx_id)
            .execute(&self.pool)
            .await?;
        } else {
            let next_retry = (Utc::now() + chrono::Duration::seconds(30 * (job.retry_count + 1)))
                .to_rfc3339();
            sqlx::query(
                "UPDATE relay_jobs SET status = 'pending', retry_count = retry_count + 1, error_message = ?, next_retry_at = ?, updated_at = ? WHERE id = ?"
            )
            .bind(error)
            .bind(&next_retry)
            .bind(&now)
            .bind(&job.id)
            .execute(&self.pool)
            .await?;
        }

        Ok(())
    }
}
