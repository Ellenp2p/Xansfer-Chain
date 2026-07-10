use std::collections::HashMap;
use crate::chains::{ChainConfig};
use crate::config::loader::{load_config, resolve_mode_chains, CctpConfig};

const ATTESTATION_API_MAINNET: &str = "https://iris-api.circle.com";
const ATTESTATION_API_TESTNET: &str = "https://iris-api-sandbox.circle.com";

#[derive(Clone)]
pub struct ChainRegistry {
    chains: HashMap<i64, ChainConfig>,
    cctp: HashMap<String, CctpConfig>,
}

impl ChainRegistry {
    pub fn new() -> Self {
        let config = load_config().expect("Failed to load chain config");
        let mut chains = HashMap::new();

        for chain in resolve_mode_chains(&config.modes.mainnet).expect("Failed to resolve mainnet chains") {
            chains.insert(chain.domain, chain);
        }

        for chain in resolve_mode_chains(&config.modes.testnet).expect("Failed to resolve testnet chains") {
            chains.insert(chain.domain, chain);
        }

        let mut cctp = HashMap::new();
        cctp.insert("mainnet".to_string(), config.modes.mainnet.cctp);
        cctp.insert("testnet".to_string(), config.modes.testnet.cctp);

        Self { chains, cctp }
    }

    pub fn get(&self, domain: i64) -> Option<&ChainConfig> {
        self.chains.get(&domain)
    }

    pub fn all(&self) -> Vec<&ChainConfig> {
        self.chains.values().collect()
    }

    pub fn transfer_types(&self, source_domain: i64, dest_domain: i64) -> Option<Vec<String>> {
        let src = self.get(source_domain)?;
        let dst = self.get(dest_domain)?;
        Some(src.supported_transfer_types(dst))
    }

    pub fn get_rpc_url(&self, domain: i64, _network_mode: &str) -> Option<String> {
        self.chains.get(&domain).map(|c| c.rpc_url.clone())
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
            let domain_key = domain.to_string();
            cctp.v2
                .message_transmitter_domains
                .get(&domain_key)
                .cloned()
                .or_else(|| Some(cctp.v2.message_transmitter.clone()))
        } else if cctp_version == 1 {
            let cctp = self.cctp.get(mode)?;
            let v1 = cctp.v1.as_ref()?;
            v1.message_transmitter.get(&domain.to_string()).cloned()
        } else {
            None
        }
    }

    pub fn get_token_messenger(
        &self,
        domain: i64,
        network_mode: &str,
        cctp_version: i64,
    ) -> Option<String> {
        let mode = normalize_mode(network_mode);
        if cctp_version == 2 {
            let cctp = self.cctp.get(mode)?;
            let domain_key = domain.to_string();
            cctp.v2
                .token_messenger_domains
                .get(&domain_key)
                .cloned()
                .or_else(|| Some(cctp.v2.token_messenger.clone()))
        } else if cctp_version == 1 {
            let cctp = self.cctp.get(mode)?;
            let v1 = cctp.v1.as_ref()?;
            v1.token_messenger.get(&domain.to_string()).cloned()
        } else {
            None
        }
    }

    pub fn get_attestation_api(&self,
        network_mode: &str,
        cctp_version: i64,
    ) -> Option<String> {
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
    let base = if network_mode == "testnet" { ATTESTATION_API_TESTNET } else { ATTESTATION_API_MAINNET };
    if cctp_version == 2 {
        Some(format!("{}/v2", base))
    } else {
        Some(base.to_string())
    }
}
