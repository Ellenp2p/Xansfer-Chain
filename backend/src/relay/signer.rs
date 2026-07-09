use sqlx::SqlitePool;
use tracing::info;

/// RelaySigner manages hot wallet operations for the relay service.
/// In MVP, private keys are stored as hex strings in environment variables.
/// Production would use HSM or encrypted key management.
pub struct RelaySigner {
    _pool: SqlitePool,
    evm_keys: std::collections::HashMap<i64, String>,
    stellar_key: Option<String>,
}

impl RelaySigner {
    pub fn new(pool: SqlitePool) -> Self {
        let mut evm_keys = std::collections::HashMap::new();

        // Load keys from environment (format: RELAY_KEY_<DOMAIN>)
        for domain in [0, 1, 2, 3, 6, 7, 10, 11, 12, 13, 14, 16, 17, 18, 21, 22, 26, 28, 30, 32] {
            let env_key = format!("RELAY_KEY_{}", domain);
            if let Ok(key) = std::env::var(&env_key) {
                if !key.is_empty() {
                    evm_keys.insert(domain, key);
                }
            }
        }

        let stellar_key = std::env::var("RELAY_KEY_STELLAR").ok().filter(|k| !k.is_empty());

        info!("Loaded {} EVM relay keys, Stellar: {}", evm_keys.len(), stellar_key.is_some());

        Self { _pool: pool, evm_keys, stellar_key }
    }

    pub fn has_key_for_domain(&self, domain: i64) -> bool {
        self.evm_keys.contains_key(&domain) || (domain == 27 && self.stellar_key.is_some())
    }
}
