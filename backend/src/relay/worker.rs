use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::db::models::{RelayJob, Transaction};
use crate::relay::signer::RelaySigner;

pub struct RelayWorker {
    pool: SqlitePool,
    signer: RelaySigner,
    tx_notify: broadcast::Receiver<String>,
}

impl RelayWorker {
    pub fn new(pool: SqlitePool, tx_notify: broadcast::Receiver<String>) -> Self {
        let signer = RelaySigner::new(pool.clone());
        Self { pool, signer, tx_notify }
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
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    if let Err(e) = self.process_pending_jobs().await {
                        error!("Relay job processor error: {e:#}");
                    }
                }
            }
        }
    }

    async fn handle_notification(&self, tx_id: &str) -> Result<()> {
        let tx: Option<Transaction> = sqlx::query_as("SELECT * FROM transactions WHERE id = ?")
            .bind(tx_id)
            .fetch_optional(&self.pool)
            .await?;

        let Some(tx) = tx else { return Ok(()) };

        if tx.transfer_type != "relay" || tx.status != "attested" {
            return Ok(());
        }

        if !self.signer.has_key_for_domain(tx.dest_domain) {
            warn!("No relay key for domain {}, skipping", tx.dest_domain);
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

        let _attestation = tx.attestation.as_ref().ok_or_else(|| anyhow::anyhow!("No attestation"))?;

        info!("Executing relay for tx {} on domain {}", tx.source_tx_hash, tx.dest_domain);

        // For MVP: simulate the relay by marking as complete
        // In production, this would:
        // 1. Build receiveMessage transaction with attestation
        // 2. Sign with relay key
        // 3. Submit to destination chain
        // 4. Wait for confirmation
        let simulated_dest_hash = format!("0x{:064x}", rand::random::<u64>());

        let now = Utc::now().to_rfc3339();

        // Update transaction as complete
        sqlx::query(
            "UPDATE transactions SET status = 'complete', dest_tx_hash = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&simulated_dest_hash)
        .bind(&now)
        .bind(&tx.id)
        .execute(&self.pool)
        .await?;

        // Update relay job as complete
        sqlx::query(
            "UPDATE relay_jobs SET status = 'complete', updated_at = ? WHERE id = ?"
        )
        .bind(&now)
        .bind(&job.id)
        .execute(&self.pool)
        .await?;

        info!("Relay complete for tx {}, dest hash: {}", tx.source_tx_hash, simulated_dest_hash);

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
            let next_retry = (Utc::now() + chrono::Duration::seconds(30 * (job.retry_count + 1))).to_rfc3339();
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
