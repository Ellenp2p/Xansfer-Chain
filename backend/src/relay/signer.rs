use sqlx::SqlitePool;
use tracing::info;

use crate::chains::{ChainType};
use crate::relay::evm_submitter::EvmKey;

/// RelaySigner manages hot wallet operations for the relay service.
/// In MVP, private keys are stored as hex strings in environment variables.
/// Production would use HSM or encrypted key management.
pub struct RelaySigner {
    _pool: SqlitePool,
    evm_keys: std::collections::HashMap<i64, EvmKey>,
    solana_keys: std::collections::HashMap<i64, String>,
    stellar_key: Option<String>,
    sui_keys: std::collections::HashMap<i64, String>,
    aptos_keys: std::collections::HashMap<i64, String>,
}

impl Clone for RelaySigner {
    fn clone(&self) -> Self {
        Self {
            _pool: self._pool.clone(),
            evm_keys: self.evm_keys.clone(),
            solana_keys: self.solana_keys.clone(),
            stellar_key: self.stellar_key.clone(),
            sui_keys: self.sui_keys.clone(),
            aptos_keys: self.aptos_keys.clone(),
        }
    }
}

impl RelaySigner {
    pub fn new(pool: SqlitePool) -> Self {
        let mut evm_keys = std::collections::HashMap::new();
        let mut solana_keys = std::collections::HashMap::new();
        let mut sui_keys = std::collections::HashMap::new();
        let mut aptos_keys = std::collections::HashMap::new();

        // Load keys from environment (format: RELAY_KEY_<DOMAIN>)
        // Domains are loaded generically; the worker will interpret them based on chain_type.
        for domain in [
            0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 13, 14, 25, 26, 27, 32,
        ] {
            let env_key = format!("RELAY_KEY_{}", domain);
            if let Ok(key) = std::env::var(&env_key) {
                if !key.is_empty() {
                    match EvmKey::from_hex(&key) {
                        Ok(evm_key) => {
                            info!("Loaded EVM relay key for domain {}: {}", domain, evm_key.address_hex());
                            evm_keys.insert(domain, evm_key);
                        }
                        Err(e) => {
                            // Not a valid EVM key; treat as base58/ed25519 string for Solana/Sui/Aptos/Stellar
                            if domain == 27 {
                                // Stellar uses its own env var below
                            } else if domain == 5 {
                                info!("Loaded Solana relay key for domain {} (base58)", domain);
                                solana_keys.insert(domain, key);
                            } else if domain == 8 {
                                info!("Loaded Sui relay key for domain {}", domain);
                                sui_keys.insert(domain, key);
                            } else if domain == 14 {
                                info!("Loaded Aptos relay key for domain {}", domain);
                                aptos_keys.insert(domain, key);
                            } else {
                                info!("Domain {} key is not EVM-compatible ({}), storing as generic", domain, e);
                            }
                        }
                    }
                }
            }
        }

        let stellar_key = std::env::var("RELAY_KEY_STELLAR").ok().filter(|k| !k.is_empty());
        if stellar_key.is_some() {
            info!("Loaded Stellar relay key");
        }

        Self {
            _pool: pool,
            evm_keys,
            solana_keys,
            stellar_key,
            sui_keys,
            aptos_keys,
        }
    }

    pub fn has_key_for_domain(&self, domain: i64, chain_type: &ChainType) -> bool {
        match chain_type {
            ChainType::Evm => self.evm_keys.contains_key(&domain),
            ChainType::Solana => self.solana_keys.contains_key(&domain),
            ChainType::Stellar => self.stellar_key.is_some(),
            ChainType::Sui => self.sui_keys.contains_key(&domain),
            ChainType::Aptos => self.aptos_keys.contains_key(&domain),
            _ => false,
        }
    }

    pub fn evm_key(&self, domain: i64) -> Option<&EvmKey> {
        self.evm_keys.get(&domain)
    }

    pub fn solana_key(&self, domain: i64) -> Option<&str> {
        self.solana_keys.get(&domain).map(|s| s.as_str())
    }

    pub fn stellar_key(&self) -> Option<&str> {
        self.stellar_key.as_deref()
    }

    pub fn sui_key(&self, domain: i64) -> Option<&str> {
        self.sui_keys.get(&domain).map(|s| s.as_str())
    }

    pub fn aptos_key(&self, domain: i64) -> Option<&str> {
        self.aptos_keys.get(&domain).map(|s| s.as_str())
    }
}
