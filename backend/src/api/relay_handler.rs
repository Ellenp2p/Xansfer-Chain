use axum::{extract::State, http::StatusCode, Json};
use crate::api::transfer::AppState;
use crate::db::models::Transaction;

/// Manually claim a transaction (for frontend-initiated claiming)
pub async fn claim_transaction(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let tx_id = body["transaction_id"]
        .as_str()
        .ok_or((StatusCode::BAD_REQUEST, "Missing transaction_id".into()))?;

    let tx: Transaction = sqlx::query_as("SELECT * FROM transactions WHERE id = ?")
        .bind(tx_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Transaction not found".into()))?;

    if tx.attestation.is_none() {
        return Err((StatusCode::BAD_REQUEST, "Attestation not yet available".into()));
    }

    if tx.status != "attested" {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Cannot claim transaction in status '{}'", tx.status),
        ));
    }

    Ok(Json(serde_json::json!({
        "message": "Claim initiated",
        "attestation": tx.attestation,
        "transaction_id": tx.id,
    })))
}
