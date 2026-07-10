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
    aptos_submitter, evm_submitter::{EvmKey, EvmSubmitter, parse_cctp_v2_amount},
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

                // If a Forwarder is configured for this domain, route the relay
                // through it so the contract can deduct a fee before forwarding
                // USDC to the user. Otherwise fall back to direct receiveMessage.
                if let Some(forwarder) = self.chains.get_forwarder(tx.dest_domain, &tx.network_mode) {
                    info!(
                        "Using Forwarder {} for relay on domain {}",
                        forwarder, tx.dest_domain
                    );

                    let max_forwarder_fee_bps: u128 = std::env::var("RELAY_MAX_FORWARDER_FEE_BPS")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(500);

                    let gross_amount = parse_cctp_v2_amount(message)?;
                    let min_amount_out = gross_amount
                        .saturating_mul(10_000 - max_forwarder_fee_bps)
                        .saturating_div(10_000);

                    let submitter = EvmSubmitter::new(
                        rpc_url,
                        chain_id,
                        forwarder,
                        Some(message_transmitter),
                        key.clone(),
                    );
                    submitter
                        .submit_mint_and_forward(
                            message,
                            attestation,
                            &tx.dest_address,
                            min_amount_out,
                            dest_chain.block_time_ms,
                        )
                        .await?
                } else {
                    let submitter = EvmSubmitter::new(
                        rpc_url,
                        chain_id,
                        message_transmitter.clone(),
                        Some(message_transmitter),
                        key.clone(),
                    );
                    submitter
                        .submit_receive_message(message, attestation, dest_chain.block_time_ms)
                        .await?
                }
            }
            ChainType::Solana => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for Solana domain {}", tx.dest_domain))?;

                let (mt_default, tmm_default) = if tx.network_mode == "testnet" {
                    (
                        "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
                        "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
                    )
                } else {
                    (
                        "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
                        "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
                    )
                };
                let message_transmitter = std::env::var("SOLANA_MESSAGE_TRANSMITTER_V2")
                    .unwrap_or_else(|_| mt_default.into());
                let token_messenger_minter = std::env::var("SOLANA_TOKEN_MESSENGER_MINTER_V2")
                    .unwrap_or_else(|_| tmm_default.into());
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
                    &tx.network_mode,
                )
                .await?
            }
            ChainType::Sui => {
                let rpc_url = self
                    .chains
                    .get_rpc_url(tx.dest_domain, &tx.network_mode)
                    .ok_or_else(|| anyhow::anyhow!("No RPC URL for Sui domain {}", tx.dest_domain))?;

                // Provide sensible testnet/mainnet defaults for the shared CCTP objects
                // if the operator has not overridden them via environment variables.
                let (mt_pkg_default, tmm_pkg_default, mt_state_default, tmm_state_default, usdc_default) =
                    if tx.network_mode == "testnet" {
                        (
                            "0x08d87d37ba49e785dde270a83f8e979605b03dc552b5548f26fdf2f49bf7ed1b",
                            "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e",
                            "0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af",
                            "0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f",
                            "0x3a915322be45c414508712322acdf4f4d5c94ac2c262f635f037e2a26f364dd3::usdc::USDC",
                        )
                    } else {
                        (
                            "0x4931e06dce648b3931f890035bd196920770e913e43e45990b383f6486fdd0a5",
                            "0x31cc14d80c175ae39777c0238f20594c6d4869cfab199f40b69f3319956b8beb",
                            "0x98234bd0fa9ac12cc0a20a144a22e36d6a32f7e0a97baaeaf9c76cdc6d122d2e",
                            "0x5252abd1137094ed1db3e0d75bc36abcd287aee4bc310f8e047727ef5682e7c2",
                            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb845e24ff689::usdc::USDC",
                        )
                    };
                let message_transmitter_package = std::env::var("SUI_MESSAGE_TRANSMITTER_PACKAGE")
                    .unwrap_or_else(|_| mt_pkg_default.into());
                let token_messenger_minter_package = std::env::var("SUI_TOKEN_MESSENGER_MINTER_PACKAGE")
                    .unwrap_or_else(|_| tmm_pkg_default.into());
                let message_transmitter_state = std::env::var("SUI_MESSAGE_TRANSMITTER_STATE")
                    .unwrap_or_else(|_| mt_state_default.into());
                let token_messenger_minter_state = std::env::var("SUI_TOKEN_MESSENGER_MINTER_STATE")
                    .unwrap_or_else(|_| tmm_state_default.into());
                if std::env::var("SUI_USDC_TYPE_TAG").is_err() {
                    std::env::set_var("SUI_USDC_TYPE_TAG", usdc_default);
                }
                if std::env::var("SUI_DENY_LIST").is_err() {
                    std::env::set_var("SUI_DENY_LIST", "0x403");
                }
                if std::env::var("SUI_TREASURY").is_err() {
                    std::env::set_var(
                        "SUI_TREASURY",
                        if tx.network_mode == "testnet" {
                            "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7"
                        } else {
                            "0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe"
                        },
                    );
                }

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
                    .ok()
                    .or_else(|| self.chains.get_message_transmitter(tx.dest_domain, &tx.network_mode, tx.cctp_version))
                    .unwrap_or_else(|| "0x081e86cebf457a0c6004f35bd648a2794698f52e0dde09a48619dcd3d4cc23d9".into());
                let token_messenger_minter = std::env::var("APTOS_TOKEN_MESSENGER_MINTER")
                    .ok()
                    .or_else(|| self.chains.get_token_messenger(tx.dest_domain, &tx.network_mode, tx.cctp_version))
                    .unwrap_or_else(|| "0x5f9b937419dda90aa06c1836b7847f65bbbe3f1217567758dc2488be31a477b9".into());
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
