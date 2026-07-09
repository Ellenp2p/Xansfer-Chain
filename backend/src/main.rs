mod api;
mod attestation;
mod chains;
mod config;
mod db;
mod relay;

use axum::{routing::{get, post}, Router};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

use api::transfer::{self, AppState};
use api::{relay_handler, ws};
use attestation::poller::AttestationPoller;
use chains::registry::ChainRegistry;
use relay::worker::RelayWorker;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("xansfer=debug".parse()?))
        .init();

    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line()));
        tracing::error!(target: "panic", %message, location = ?location, "process panicked");
    }));

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:xansfer.db?mode=rwc".into());
    let pool = db::init_db(&database_url).await?;
    let chains = ChainRegistry::new();
    let (tx_notify, _) = broadcast::channel::<String>(256);

    let poller = Arc::new(AttestationPoller::new(pool.clone(), tx_notify.clone(), chains.clone()));

    // Spawn attestation poller background loop
    let poller_bg = poller.clone();
    tokio::spawn(async move {
        poller_bg.run().await;
    });

    let state = AppState {
        pool: pool.clone(),
        chains,
        poller,
        tx_notify: tx_notify.clone(),
    };

    // Spawn relay worker
    let relay_rx = tx_notify.subscribe();
    tokio::spawn(async move {
        let mut worker = RelayWorker::new(pool.clone(), relay_rx);
        worker.run().await;
    });

    let app = Router::new()
        .route("/api/chains", get(transfer::list_chains))
        .route("/api/transfer-types/:source/:dest", get(transfer::transfer_types))
        .route("/api/transactions", post(transfer::create_transaction))
        .route("/api/transactions/:id", get(transfer::get_transaction))
        .route("/api/transactions/:id/status", get(transfer::get_transaction_status))
        .route("/api/transactions/:id/claim", post(transfer::report_claim))
        .route("/api/transactions/address", get(transfer::list_transactions))
        .route("/api/lookup", get(transfer::lookup_transaction))
        .route("/api/relay/claim", post(relay_handler::claim_transaction))
        .route("/ws", get(ws::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("Server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
