use std::collections::HashMap;

use serde::Deserialize;
use thiserror::Error;

use crate::chains::{ChainConfig, ChainType};

const DEFAULT_CONFIG_PATH: &str = "config/chains.json";
const CONFIG_PATH_ENV: &str = "CHAIN_CONFIG";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io error reading config: {0}")]
    Io(#[from] std::io::Error),
    #[error("json parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("missing environment variable {0} referenced by config")]
    MissingEnv(String),
    #[error("validation error: {0}")]
    Validation(String),
}

#[derive(Debug, Deserialize)]
pub struct ChainsConfig {
    pub version: u32,
    pub modes: Modes,
}

#[derive(Debug, Deserialize)]
pub struct Modes {
    pub mainnet: ModeConfig,
    pub testnet: ModeConfig,
}

#[derive(Debug, Deserialize)]
pub struct ModeConfig {
    pub chains: Vec<RawChainConfig>,
    pub cctp: CctpConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CctpConfig {
    pub v2: CctpVersionConfig,
    pub v1: Option<CctpVersionConfigWithDomains>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CctpVersionConfig {
    pub token_messenger: String,
    pub message_transmitter: String,
    pub attestation_api: String,
    #[serde(default)]
    pub message_transmitter_domains: HashMap<String, String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CctpVersionConfigWithDomains {
    pub message_transmitter: HashMap<String, String>,
    pub attestation_api: String,
}

#[derive(Debug, Deserialize)]
pub struct RawChainConfig {
    pub domain: i64,
    pub name: String,
    pub chain_id: Option<u64>,
    pub rpc_url: ResolvableString,
    pub explorer_url: String,
    pub usdc_address: String,
    pub usdc_sac: Option<String>,
    pub cctp_versions: Vec<u32>,
    pub chain_type: ChainType,
    pub supports_fast_transfer: bool,
    pub supports_forwarding: bool,
    pub block_time_ms: u64,
    pub finality_blocks: u32,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
pub enum ResolvableString {
    Plain(String),
    EnvRef { env: String },
    Template { template: String },
}

impl ResolvableString {
    pub fn resolve(&self) -> Result<String, ConfigError> {
        match self {
            ResolvableString::Plain(s) => Ok(s.clone()),
            ResolvableString::EnvRef { env } => std::env::var(env)
                .map_err(|_| ConfigError::MissingEnv(env.clone())),
            ResolvableString::Template { template } => interpolate(template),
        }
    }
}

fn interpolate(template: &str) -> Result<String, ConfigError> {
    let mut result = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '$' && chars.peek() == Some(&'{') {
            chars.next(); // consume '{'
            let mut var_name = String::new();
            loop {
                match chars.next() {
                    Some('}') => break,
                    Some(c) => var_name.push(c),
                    None => return Err(ConfigError::Validation(format!(
                        "unclosed variable reference in template: {}",
                        template
                    ))),
                }
            }
            let value = std::env::var(&var_name)
                .map_err(|_| ConfigError::MissingEnv(var_name.clone()))?;
            result.push_str(&value);
        } else {
            result.push(ch);
        }
    }

    Ok(result)
}

pub fn load_config() -> Result<ChainsConfig, ConfigError> {
    let contents = if let Ok(path) = std::env::var(CONFIG_PATH_ENV) {
        std::fs::read_to_string(&path)?
    } else if let Ok(contents) = std::fs::read_to_string(DEFAULT_CONFIG_PATH) {
        contents
    } else {
        // When running from the backend/ subdirectory in dev, the project root
        // config is one level up.
        std::fs::read_to_string("../config/chains.json")?
    };
    let config: ChainsConfig = serde_json::from_str(&contents)?;
    validate(&config)?;
    Ok(config)
}

pub fn resolve_mode_chains(mode_config: &ModeConfig) -> Result<Vec<ChainConfig>, ConfigError> {
    let mut chains = Vec::with_capacity(mode_config.chains.len());
    let mut seen_domains = std::collections::HashSet::new();

    for raw in &mode_config.chains {
        if !seen_domains.insert(raw.domain) {
            return Err(ConfigError::Validation(format!(
                "duplicate domain {} in config",
                raw.domain
            )));
        }

        if raw.name.is_empty() {
            return Err(ConfigError::Validation(format!(
                "chain domain {} has empty name",
                raw.domain
            )));
        }

        if raw.chain_type == ChainType::Evm && raw.chain_id.is_none() {
            return Err(ConfigError::Validation(format!(
                "EVM chain {} (domain {}) must have chain_id",
                raw.name, raw.domain
            )));
        }

        if raw.chain_type == ChainType::Stellar && raw.usdc_sac.is_none() {
            return Err(ConfigError::Validation(format!(
                "Stellar chain {} (domain {}) must have usdc_sac",
                raw.name, raw.domain
            )));
        }

        let rpc_url = raw.rpc_url.resolve()?;
        if rpc_url.is_empty() {
            return Err(ConfigError::Validation(format!(
                "chain {} (domain {}) has empty rpc_url after resolution",
                raw.name, raw.domain
            )));
        }

        chains.push(ChainConfig {
            domain: raw.domain,
            name: raw.name.clone(),
            chain_id: raw.chain_id,
            rpc_url,
            explorer_url: raw.explorer_url.clone(),
            usdc_address: raw.usdc_address.clone(),
            usdc_sac: raw.usdc_sac.clone(),
            cctp_versions: raw.cctp_versions.clone(),
            chain_type: raw.chain_type.clone(),
            supports_fast_transfer: raw.supports_fast_transfer,
            supports_forwarding: raw.supports_forwarding,
            block_time_ms: raw.block_time_ms,
            finality_blocks: raw.finality_blocks,
        });
    }

    Ok(chains)
}

fn validate(config: &ChainsConfig) -> Result<(), ConfigError> {
    if config.version != 1 {
        return Err(ConfigError::Validation(format!(
            "unsupported config version {}",
            config.version
        )));
    }

    for mode in ["mainnet", "testnet"] {
        let mode_config = match mode {
            "mainnet" => &config.modes.mainnet,
            "testnet" => &config.modes.testnet,
            _ => unreachable!(),
        };

        if mode_config.cctp.v2.token_messenger.is_empty()
            || mode_config.cctp.v2.message_transmitter.is_empty()
            || mode_config.cctp.v2.attestation_api.is_empty()
        {
            return Err(ConfigError::Validation(format!(
                "CCTP v2 config for {} is incomplete",
                mode
            )));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interpolate_plain() {
        assert_eq!(interpolate("https://example.com").unwrap(), "https://example.com");
    }

    #[test]
    fn test_interpolate_with_env() {
        std::env::set_var("TEST_KEY", "secret123");
        assert_eq!(
            interpolate("https://example.com/v2/${TEST_KEY}").unwrap(),
            "https://example.com/v2/secret123"
        );
    }

    #[test]
    fn test_resolvable_string_env() {
        std::env::set_var("TEST_RPC", "https://rpc.test");
        let s = ResolvableString::EnvRef { env: "TEST_RPC".to_string() };
        assert_eq!(s.resolve().unwrap(), "https://rpc.test");
    }
}
