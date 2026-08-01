use std::collections::HashMap;
use crate::chains::ChainConfig;
use crate::config::loader::{load_config, resolve_mode_chains, CctpConfig};

const ATTESTATION_API_MAINNET: &str = "https://iris-api.circle.com";
const ATTESTATION_API_TESTNET: &str = "https://iris-api-sandbox.circle.com";

/// Chain registry keyed by network mode ("mainnet" | "testnet") then domain.
///
/// Config comes exclusively from `config/chains.json` (or `$CHAIN_CONFIG`).
/// Load errors are fatal — silently falling back to stale built-in defaults
/// risks routing funds against wrong chain addresses in production.
#[derive(Clone)]
pub struct ChainRegistry {
    chains: HashMap<String, HashMap<i64, ChainConfig>>,
    cctp: HashMap<String, CctpConfig>,
}

impl ChainRegistry {
    pub fn new() -> Self {
        let config = load_config().expect("failed to load chain config (config/chains.json)");

        let mainnet_chains = resolve_mode_chains(&config.modes.mainnet)
            .expect("failed to resolve mainnet chains");
        let mut mainnet = HashMap::new();
        for chain in mainnet_chains {
            mainnet.insert(chain.domain, chain);
        }

        let testnet_chains = resolve_mode_chains(&config.modes.testnet)
            .expect("failed to resolve testnet chains");
        let mut testnet = HashMap::new();
        for chain in testnet_chains {
            testnet.insert(chain.domain, chain);
        }

        let mut chains = HashMap::new();
        chains.insert("mainnet".to_string(), mainnet);
        chains.insert("testnet".to_string(), testnet);

        let mut cctp = HashMap::new();
        cctp.insert("mainnet".to_string(), config.modes.mainnet.cctp);
        cctp.insert("testnet".to_string(), config.modes.testnet.cctp);

        Self { chains, cctp }
    }

    pub fn get(&self, domain: i64, network_mode: &str) -> Option<&ChainConfig> {
        self.chains
            .get(normalize_mode(network_mode))?
            .get(&domain)
    }

    pub fn all(&self, network_mode: &str) -> Vec<&ChainConfig> {
        self.chains
            .get(normalize_mode(network_mode))
            .map(|m| m.values().collect())
            .unwrap_or_default()
    }

    pub fn transfer_types(&self, source_domain: i64, dest_domain: i64, network_mode: &str) -> Option<Vec<String>> {
        let src = self.get(source_domain, network_mode)?;
        let dst = self.get(dest_domain, network_mode)?;
        Some(src.supported_transfer_types(dst))
    }

    pub fn get_rpc_url(&self, domain: i64, network_mode: &str) -> Option<String> {
        self.get(domain, network_mode).map(|c| c.rpc_url.clone())
    }

    pub fn get_message_transmitter(
        &self,
        domain: i64,
        network_mode: &str,
        cctp_version: i64,
    ) -> Option<String> {
        let mode = normalize_mode(network_mode);
        if cctp_version == 2 {
            let cctp = self.cctp.get(mode)?;
            Some(cctp.v2.message_transmitter.clone())
        } else if cctp_version == 1 {
            let cctp = self.cctp.get(mode)?;
            let v1 = cctp.v1.as_ref()?;
            v1.message_transmitter.get(&domain.to_string()).cloned()
        } else {
            None
        }
    }

    pub fn get_attestation_api(&self, network_mode: &str, cctp_version: i64) -> Option<String> {
        let mode = normalize_mode(network_mode);
        let cctp = self.cctp.get(mode)?;
        let base = if cctp_version == 2 {
            cctp.v2.attestation_api.clone()
        } else {
            cctp.v1.as_ref()?.attestation_api.clone()
        };
        if cctp_version == 2 {
            Some(format!("{}/v2", base))
        } else {
            Some(base)
        }
    }
}

fn normalize_mode(network_mode: &str) -> &str {
    if network_mode == "testnet" { "testnet" } else { "mainnet" }
}

pub fn default_attestation_api(network_mode: &str, cctp_version: i64) -> Option<String> {
    let base = if network_mode == "testnet" {
        ATTESTATION_API_TESTNET
    } else {
        ATTESTATION_API_MAINNET
    };
    if cctp_version == 2 {
        Some(format!("{}/v2", base))
    } else {
        Some(base.to_string())
    }
}
