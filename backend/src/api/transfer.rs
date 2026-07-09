use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use sqlx::SqlitePool;

use crate::attestation::poller::{AttestationPoller, parse_message_meta};
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

    // Reject placeholder hashes (all zeros), with or without 0x prefix
    let normalized_hash = req.source_tx_hash.strip_prefix("0x").unwrap_or(&req.source_tx_hash).to_lowercase();
    if normalized_hash.len() == 64 && normalized_hash.chars().all(|c| c == '0') {
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
                        tracing::info!(
                            "Message {} already claimed on-chain (dest_domain={}), marking complete",
                            tx.source_tx_hash, tx.dest_domain
                        );
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
    let network_mode = params.mode.as_deref().unwrap_or("testnet");
    let cctp_version = params.cctp_version.unwrap_or(2);

    // 1. Call Circle Iris API first so we can recover metadata even if DB is empty.
    let circle_status = state
        .poller
        .check_transaction(params.source_domain, &params.source_tx_hash, cctp_version, network_mode)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Circle lookup failed: {e}")))?;

    // 2. Parse metadata from Circle message when available.
    let mut parsed_version = cctp_version;
    let mut parsed_dest_domain: Option<i64> = None;
    if let Some(ref msg) = circle_status {
        if let Some(ref message_hex) = msg.message {
            if let Some((v, _src, dst)) = parse_message_meta(message_hex) {
                parsed_version = v;
                parsed_dest_domain = Some(dst);
            }
        }
        if let Some(v) = msg.cctp_version {
            parsed_version = v;
        }
    }

    let final_version = params.cctp_version.unwrap_or(parsed_version);
    let final_dest_domain = params.dest_domain
        .or(parsed_dest_domain)
        .ok_or((StatusCode::BAD_REQUEST, "dest_domain is required when it cannot be parsed from the message".into()))?;
    let final_amount = params.amount
        .clone()
        .unwrap_or_else(|| "0".to_string());

    // 3. Upsert transaction in DB.
    let tx: Option<Transaction> = sqlx::query_as(
        "SELECT * FROM transactions WHERE source_tx_hash = ? AND source_domain = ?",
    )
    .bind(&params.source_tx_hash)
    .bind(params.source_domain)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    if tx.is_none() {
        // No DB record — create one from manual lookup data.
        let now = Utc::now().to_rfc3339();
        let new_id = uuid::Uuid::new_v4().to_string();
        let status = circle_status.as_ref().and_then(|m| m.attestation.as_ref()).map(|a| {
            if a == "PENDING" || a.is_empty() { "pending" }
            else if circle_status.as_ref().unwrap().forward_state.as_deref() == Some("COMPLETE") { "complete" }
            else { "attested" }
        }).unwrap_or("pending");

        let attestation = circle_status.as_ref().and_then(|m| m.attestation.clone());
        let message = circle_status.as_ref().and_then(|m| m.message.clone());
        let forward_tx = circle_status.as_ref().and_then(|m| m.forward_tx_hash.clone());

        sqlx::query(
            "INSERT OR IGNORE INTO transactions (id, source_domain, dest_domain, source_tx_hash, source_address, dest_address, amount, status, cctp_version, transfer_type, network_mode, attestation, message, dest_tx_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&new_id)
        .bind(params.source_domain)
        .bind(final_dest_domain)
        .bind(&params.source_tx_hash)
        .bind("")
        .bind("")
        .bind(&final_amount)
        .bind(status)
        .bind(final_version)
        .bind("standard")
        .bind(network_mode)
        .bind(&attestation)
        .bind(&message)
        .bind(&forward_tx)
        .bind(&now)
        .bind(&now)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB insert error: {}", e)))?;
    } else if let Some(ref msg) = circle_status {
        // Existing record — update attestation/message if Circle has new data.
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
                .bind(&tx.as_ref().unwrap().id)
                .execute(&state.pool)
                .await;
            }
        }
    }

    // 4. Re-fetch after potential insert/update.
    let mut tx: Option<Transaction> = sqlx::query_as(
        "SELECT * FROM transactions WHERE source_tx_hash = ? AND source_domain = ?",
    )
    .bind(&params.source_tx_hash)
    .bind(params.source_domain)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {}", e)))?;

    // 5. If attested and message available, check on-chain if already claimed.
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
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    // Support both legacy /address/:addr and new /address?address=...&address=...
    let addresses: Vec<&str> = params
        .get("address")
        .map(|s| s.split(',').collect())
        .unwrap_or_default();

    let txs: Vec<Transaction> = if addresses.is_empty() {
        Vec::new()
    } else {
        // Build IN clause safely with QueryBuilder
        let mut builder: sqlx::QueryBuilder<sqlx::Sqlite> =
            sqlx::QueryBuilder::new("SELECT * FROM transactions WHERE source_address IN (");
        let mut separated = builder.separated(", ");
        for _ in &addresses {
            separated.push("?");
        }
        separated.push_unseparated(") ORDER BY created_at DESC LIMIT 50");

        let mut query = builder.build_query_as();
        for addr in &addresses {
            query = query.bind(*addr);
        }
        query.fetch_all(&state.pool).await.unwrap_or_default()
    };

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
