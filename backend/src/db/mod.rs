pub mod models;

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{QueryBuilder, SqlitePool, Row};
use anyhow::Result;

pub async fn init_db(database_url: &str) -> Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await?;

    sqlx::query(include_str!("../../migrations/001_init.sql"))
        .execute(&pool)
        .await?;

    // Add missing columns to existing tables
    let desired_cols: &[(&str, &str, &str)] = &[
        ("transactions", "cctp_version", "INTEGER NOT NULL DEFAULT 2"),
        ("transactions", "transfer_type", "TEXT NOT NULL DEFAULT 'standard'"),
        ("transactions", "attestation", "TEXT"),
        ("transactions", "message", "TEXT"),
        ("transactions", "dest_tx_hash", "TEXT"),
        ("transactions", "claimed_at", "TEXT"),
        ("transactions", "error_message", "TEXT"),
        ("transactions", "network_mode", "TEXT NOT NULL DEFAULT 'testnet'"),
    ];

    for &(_table, col, typedef) in desired_cols {
        let existing: Vec<String> = sqlx::query("PRAGMA table_info(transactions)")
            .fetch_all(&pool)
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|row| row.try_get::<String, _>("name").ok())
            .collect();

        if !existing.iter().any(|c| c == col) {
            let mut builder: QueryBuilder<sqlx::Sqlite> = QueryBuilder::new("ALTER TABLE ");
            builder.push("transactions");
            builder.push(" ADD COLUMN ");
            builder.push(col);
            builder.push(" ");
            builder.push(typedef);
            if let Err(e) = builder.build().execute(&pool).await {
                tracing::warn!("Failed to add transactions.{}: {}", col, e);
            }
        }
    }

    Ok(pool)
}
