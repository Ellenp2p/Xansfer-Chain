pub mod registry;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    pub domain: i64,
    pub name: String,
    pub chain_id: Option<u64>,
    pub rpc_url: String,
    pub explorer_url: String,
    pub usdc_address: String,
    pub token_messenger_v2: String,
    pub message_transmitter_v2: String,
    pub token_messenger_v1: Option<String>,
    pub message_transmitter_v1: Option<String>,
    pub cctp_versions: Vec<u32>,
    pub chain_type: ChainType,
    pub supports_fast_transfer: bool,
    pub supports_forwarding: bool,
    pub block_time_ms: u64,
    pub finality_blocks: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChainType {
    Evm,
    Stellar,
    Solana,
    Starknet,
    Aptos,
    Sui,
}

impl ChainConfig {
    pub fn explorer_tx_url(&self, tx_hash: &str) -> String {
        format!("{}/tx/{}", self.explorer_url, tx_hash)
    }

    pub fn supported_transfer_types(&self, dest: &ChainConfig) -> Vec<String> {
        let mut types = vec!["standard".to_string()];

        if self.supports_fast_transfer {
            types.push("fast".to_string());
        }

        if self.supports_forwarding && dest.supports_forwarding {
            types.push("forward".to_string());
        }

        // Relay is always available as fallback
        types.push("relay".to_string());

        types
    }
}
