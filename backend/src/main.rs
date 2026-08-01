mod api;
mod attestation;
mod chains;
mod config;
mod db;
mod relay;

use axum::{http::Method, routing::{get, post}, Router};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;

use api::transfer::{self, AppState};
use api::ws;
use attestation::poller::AttestationPoller;
use chains::registry::ChainRegistry;
use relay::worker::RelayWorker;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("xansfer=debug".parse()?))
        .init();

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:xansfer.db?mode=rwc".into());
    let pool = db::init_db(&database_url).await?;
    let chains = ChainRegistry::new();
    let (tx_notify, _) = broadcast::channel::<String>(256);

    let poller = Arc::new(AttestationPoller::new(pool.clone(), tx_notify.clone(), chains.clone()));

    // Background attestation poller: periodically checks pending transactions
    // against the Circle Iris API and persists attestations to the DB.
    {
        let poller = poller.clone();
        tokio::spawn(async move { poller.run().await });
    }

    let state = AppState {
        pool: pool.clone(),
        chains,
        poller,
        tx_notify: tx_notify.clone(),
    };

    // Relay worker is opt-in (RELAY_ENABLED=true). The relay implementation is
    // currently a simulation and is NOT production-safe — keep it disabled unless
    // the real on-chain executor is implemented.
    let relay_enabled = std::env::var("RELAY_ENABLED").map(|v| v == "1" || v == "true").unwrap_or(false);
    if relay_enabled {
        let relay_rx = tx_notify.subscribe();
        tokio::spawn(async move {
            let mut worker = RelayWorker::new(pool.clone(), relay_rx);
            worker.run().await;
        });
    } else {
        tracing::info!("Relay worker disabled (set RELAY_ENABLED=true to enable)");
    }

    let app = Router::new()
        .route("/api/chains", get(transfer::list_chains))
        .route("/api/transfer-types/:source/:dest", get(transfer::transfer_types))
        .route("/api/transactions", post(transfer::create_transaction))
        .route("/api/transactions/:id", get(transfer::get_transaction))
        .route("/api/transactions/:id/status", get(transfer::get_transaction_status))
        .route("/api/transactions/:id/claim", post(transfer::report_claim))
        .route("/api/transactions/address", get(transfer::list_transactions))
        .route("/api/lookup", get(transfer::lookup_transaction))
        .route("/ws", get(ws::ws_handler))
        .layer(cors_layer())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Build the CORS layer. Allow specific origins via `ALLOWED_ORIGINS`
/// (comma-separated). Falls back to permissive for local development.
fn cors_layer() -> CorsLayer {
    use axum::http::HeaderValue;

    let origins: Vec<HeaderValue> = std::env::var("ALLOWED_ORIGINS")
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .filter_map(|o| o.parse().ok())
                .collect()
        })
        .unwrap_or_default();

    if origins.is_empty() {
        tracing::warn!("ALLOWED_ORIGINS not set — CORS is permissive. Set it in production.");
        return CorsLayer::permissive();
    }

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any)
}
