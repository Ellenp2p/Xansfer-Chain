use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use sqlx::SqlitePool;

use crate::attestation::poller::AttestationPoller;
use crate::chains::registry::ChainRegistry;
use crate::db::models::{
    CreateTransactionRequest, LookupRequest, RelayJob, Transaction, TransactionStatusResponse,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub chains: ChainRegistry,
    pub poller: std::sync::Arc<AttestationPoller>,
    pub tx_notify: tokio::sync::broadcast::Sender<String>,
}

pub async fn list_chains(State(state): State<AppState>) -> Json<serde_json::Value> {
    let chains = state.chains.all();
    Json(serde_json::json!({ "chains": chains }))
}

pub async fn transfer_types(
    State(state): State<AppState>,
    Path((source, dest)): Path<(i64, i64)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.chains.transfer_types(source, dest) {
        Some(types) => Ok(Json(serde_json::json!({ "transfer_types": types }))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

pub async fn create_transaction(
    State(state): State<AppState>,
    Json(req): Json<CreateTransactionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    if state.chains.get(req.source_domain).is_none() {
        return Err((StatusCode::BAD_REQUEST, "Invalid source domain".into()));
    }
    if state.chains.get(req.dest_domain).is_none() {
        return Err((StatusCode::BAD_REQUEST, "Invalid dest domain".into()));
    }

    // Reject placeholder hashes (all zeros)
    let zero_hash = "0x".to_string() + &"0".repeat(64);
    if req.source_tx_hash == zero_hash {
        return Err((StatusCode::BAD_REQUEST, "Invalid source transaction hash".into()));
    }

    let existing: Option<Transaction> = sqlx::query_as(
        "SELECT * FROM transactions WHERE source_tx_hash = ?"
    )
    .bind(&req.source_tx_hash)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(tx) = existing {
        return Ok((StatusCode::OK, Json(serde_json::json!({ "transaction": tx }))));
    }

    let tx = Transaction::new(&req);
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO transactions (id, source_domain, dest_domain, source_tx_hash, source_address, dest_address, amount, status, cctp_version, transfer_type, network_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&tx.id)
    .bind(tx.source_domain)
    .bind(tx.dest_domain)
    .bind(&tx.source_tx_hash)
    .bind(&tx.source_address)
    .bind(&tx.dest_address)
    .bind(&tx.amount)
    .bind(&tx.status)
    .bind(tx.cctp_version)
    .bind(&tx.transfer_type)
    .bind(&tx.network_mode)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if req.use_relay.unwrap_or(false) {
        sqlx::query("UPDATE transactions SET transfer_type = 'relay' WHERE id = ?")
            .bind(&tx.id)
            .execute(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    Ok((StatusCode::CREATED, Json(serde_json::json!({ "transaction": tx }))))
}

pub async fn get_transaction(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let tx: Option<Transaction> = sqlx::query_as("SELECT * FROM transactions WHERE source_tx_hash = ?")
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match tx {
        Some(tx) => Ok(Json(serde_json::json!({ "transaction": tx }))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

pub async fn get_transaction_status(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<TransactionStatusResponse>, (StatusCode, String)> {
    let tx: Transaction = sqlx::query_as("SELECT * FROM transactions WHERE source_tx_hash = ?")
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?
        .ok_or((StatusCode::NOT_FOUND, "Transaction not found".into()))?;

    // If still pending, check Iris API on-demand
    if tx.status == "pending" || tx.status == "attested" {
        if let Ok(Some(msg)) = state.poller.check_transaction(
            tx.source_domain, &tx.source_tx_hash, tx.cctp_version, &tx.network_mode
        ).await {
            if let Some(ref attestation) = msg.attestation {
                if attestation != "PENDING" && !attestation.is_empty() {
                    let now = Utc::now().to_rfc3339();
                    let forward_complete = msg.forward_state.as_deref() == Some("COMPLETE");
                    let new_status = if forward_complete { "complete" } else { "attested" };
                    let dest_tx = if forward_complete { msg.forward_tx_hash.clone() } else { None };

                    sqlx::query(
                        "UPDATE transactions SET status = ?, attestation = ?, message = ?, dest_tx_hash = ?, updated_at = ? WHERE source_tx_hash = ?"
                    )
                    .bind(new_status)
                    .bind(attestation)
                    .bind(&msg.message)
                    .bind(&dest_tx)
                    .bind(&now)
                    .bind(&hash)
                    .execute(&state.pool)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;
                }
            }
        }
    }

    // Re-fetch after potential update
    let tx: Transaction = sqlx::query_as("SELECT * FROM transactions WHERE source_tx_hash = ?")
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?
        .ok_or((StatusCode::NOT_FOUND, "Transaction not found".into()))?;

    // If attested and message available, check on-chain if already claimed
    let mut tx = tx;
    if tx.status == "attested" {
        if let Some(ref message) = tx.message {
            if let (Some(rpc), Some(mt)) = (
                state.chains.get_rpc_url(tx.dest_domain, &tx.network_mode),
                state.chains.get_message_transmitter(tx.dest_domain, &tx.network_mode, tx.cctp_version),
            ) {
                match state.poller.check_message_received(&rpc, &mt, message).await {
                    Ok(true) => {
                        let now = Utc::now().to_rfc3339();
                        tracing::info!("Message {} already claimed on-chain, marking complete", tx.source_tx_hash);
                        sqlx::query(
                            "UPDATE transactions SET status = 'complete', claimed_at = ?, updated_at = ? WHERE source_tx_hash = ?"
                        )
                        .bind(&now)
                        .bind(&now)
                        .bind(&hash)
                        .execute(&state.pool)
                        .await
                        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

                        tx.status = "complete".to_string();
                        tx.claimed_at = Some(now);
                    }
                    Ok(false) => {
                        tracing::debug!("Message {} not yet claimed on-chain", tx.source_tx_hash);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to check on-chain claim status for {}: {e:#}", tx.source_tx_hash);
                    }
                }
            }
        }
    }

    let relay_job: Option<RelayJob> = sqlx::query_as(
        "SELECT * FROM relay_jobs WHERE tx_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&tx.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    let attestation_ready = tx.attestation.is_some();
    let claimed = tx.claimed_at.is_some() || tx.status == "complete";
    let can_claim = attestation_ready && tx.status == "attested";

    Ok(Json(TransactionStatusResponse {
        transaction: tx,
        attestation_ready,
        can_claim,
        claimed,
        relay_job,
    }))
}

pub async fn lookup_transaction(
    State(state): State<AppState>,
    Query(params): Query<LookupRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let tx: Option<Transaction> = sqlx::query_as(
        "SELECT * FROM transactions WHERE source_tx_hash = ? AND source_domain = ?",
    )
    .bind(&params.source_tx_hash)
    .bind(params.source_domain)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    let version = tx.as_ref().map(|t| t.cctp_version).unwrap_or(2);
    let network_mode = params.mode.as_deref()
        .or_else(|| tx.as_ref().map(|t| t.network_mode.as_str()))
        .unwrap_or("testnet");

    let circle_status = state
        .poller
        .check_transaction(params.source_domain, &params.source_tx_hash, version, network_mode)
        .await
        .ok()
        .flatten();

    // If we got attestation data from Circle, update the DB immediately
    if let (Some(ref tx), Some(ref msg)) = (&tx, &circle_status) {
        if let Some(ref attestation) = msg.attestation {
            if attestation != "PENDING" && !attestation.is_empty() {
                let now = Utc::now().to_rfc3339();
                let forward_complete = msg.forward_state.as_deref() == Some("COMPLETE");
                let new_status = if forward_complete { "complete" } else { "attested" };
                let dest_tx = if forward_complete { msg.forward_tx_hash.clone() } else { None };

                let _ = sqlx::query(
                    "UPDATE transactions SET status = ?, attestation = ?, message = ?, dest_tx_hash = ?, updated_at = ? WHERE id = ?"
                )
                .bind(new_status)
                .bind(attestation)
                .bind(&msg.message)
                .bind(&dest_tx)
                .bind(&now)
                .bind(&tx.id)
                .execute(&state.pool)
                .await;
            }
        }
    }

    // Re-fetch the updated transaction
    let mut tx: Option<Transaction> = sqlx::query_as(
        "SELECT * FROM transactions WHERE source_tx_hash = ? AND source_domain = ?",
    )
    .bind(&params.source_tx_hash)
    .bind(params.source_domain)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    // If attested and message available, check on-chain if already claimed
    if let Some(ref t) = tx {
        if t.status == "attested" {
            if let Some(ref message) = t.message {
                if let (Some(rpc), Some(mt)) = (
                    state.chains.get_rpc_url(t.dest_domain, &t.network_mode),
                    state.chains.get_message_transmitter(t.dest_domain, &t.network_mode, t.cctp_version),
                ) {
                    match state.poller.check_message_received(&rpc, &mt, message).await {
                        Ok(true) => {
                            let now = Utc::now().to_rfc3339();
                            tracing::info!("Message {} already claimed on-chain (lookup)", t.source_tx_hash);
                            sqlx::query(
                                "UPDATE transactions SET status = 'complete', claimed_at = ?, updated_at = ? WHERE id = ?"
                            )
                            .bind(&now)
                            .bind(&now)
                            .bind(&t.id)
                            .execute(&state.pool)
                            .await
                            .ok();

                            // Re-fetch after update
                            tx = sqlx::query_as(
                                "SELECT * FROM transactions WHERE source_tx_hash = ? AND source_domain = ?",
                            )
                            .bind(&params.source_tx_hash)
                            .bind(params.source_domain)
                            .fetch_optional(&state.pool)
                            .await
                            .ok()
                            .flatten();
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(Json(serde_json::json!({
        "transaction": tx,
        "circle_status": circle_status,
    })))
}

pub async fn list_transactions(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Json<serde_json::Value> {
    let txs: Vec<Transaction> = sqlx::query_as(
        "SELECT * FROM transactions WHERE source_address = ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&address)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    Json(serde_json::json!({ "transactions": txs }))
}

/// POST /api/transactions/:hash/claim — report a successful claim from the frontend
pub async fn report_claim(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let dest_tx_hash = body.get("dest_tx_hash")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let now = Utc::now().to_rfc3339();

    let result = sqlx::query(
        "UPDATE transactions SET status = 'complete', dest_tx_hash = ?, claimed_at = ?, updated_at = ? WHERE source_tx_hash = ? AND status != 'complete'"
    )
    .bind(dest_tx_hash)
    .bind(&now)
    .bind(&now)
    .bind(&hash)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    if result.rows_affected() == 0 {
        let tx: Option<Transaction> = sqlx::query_as("SELECT * FROM transactions WHERE source_tx_hash = ?")
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

        if tx.is_none() {
            return Err((StatusCode::NOT_FOUND, "Transaction not found".into()));
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
