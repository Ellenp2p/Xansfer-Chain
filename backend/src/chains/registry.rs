use std::collections::HashMap;
use crate::chains::{ChainConfig, ChainType};

// CCTP v2 MessageTransmitter addresses — same on ALL chains per network
const MSG_TRANSMITTER_V2_MAINNET: &str = "0x81D40F21F12A8F0E3252Bccb954D720d9770512A";
const MSG_TRANSMITTER_V2_TESTNET: &str = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

// CCTP v1 MessageTransmitter per domain (testnet)
fn v1_msg_transmitter_testnet(domain: i64) -> Option<&'static str> {
    match domain {
        0 => Some("0x7865fAfC2db2093669d92c0F33AeEF291086BEFD"),  // Sepolia
        1 => Some("0xa9fb1b30a9d03985dF65DdBb7A6a6B63e64EF04c"),  // Fuji
        _ => None,
    }
}

/// Returns the testnet RPC URL for known EVM domains
fn testnet_rpc(domain: i64) -> Option<&'static str> {
    match domain {
        0 => Some("https://ethereum-sepolia-rpc.publicnode.com"),   // Ethereum Sepolia
        1 => Some("https://api.avax-test.network/ext/bc/C/rpc"),    // Avalanche Fuji
        2 => Some("https://sepolia.optimism.io"),                   // OP Sepolia
        3 => Some("https://sepolia-rollup.arbitrum.io/rpc"),        // Arbitrum Sepolia
        6 => Some("https://sepolia.base.org"),                      // Base Sepolia
        7 => Some("https://rpc-amoy.polygon.technology"),           // Polygon Amoy
        10 => Some("https://sepolia.unichain.org"),                 // Unichain Sepolia
        11 => Some("https://rpc.sepolia.linea.build"),              // Linea Sepolia
        13 => Some("https://rpc.testnet.soniclabs.com"),            // Sonic Testnet
        17 => Some("https://data-seed-prebsc-1-s1.binance.org:8545"), // BNB Testnet
        32 => Some("https://evm.cronos.org/testnet"),               // Cronos Testnet
        _ => None,
    }
}

#[derive(Clone)]
pub struct ChainRegistry {
    chains: HashMap<i64, ChainConfig>,
}

impl ChainRegistry {
    pub fn new() -> Self {
        let mut chains = HashMap::new();
        let defaults = default_chains();
        for chain in defaults {
            chains.insert(chain.domain, chain);
        }
        Self { chains }
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

    /// Get the correct RPC URL for a domain based on network_mode
    pub fn get_rpc_url(&self, domain: i64, network_mode: &str) -> Option<String> {
        if network_mode == "testnet" {
            testnet_rpc(domain).map(|s| s.to_string())
        } else {
            self.chains.get(&domain).map(|c| c.rpc_url.clone())
        }
    }

    /// Get the MessageTransmitter contract address for a domain
    pub fn get_message_transmitter(&self, domain: i64, network_mode: &str, cctp_version: i64) -> Option<String> {
        if cctp_version == 2 {
            // v2: same address across ALL chains
            let addr = if network_mode == "testnet" {
                MSG_TRANSMITTER_V2_TESTNET
            } else {
                MSG_TRANSMITTER_V2_MAINNET
            };
            Some(addr.to_string())
        } else if cctp_version == 1 {
            // v1: per-domain addresses
            if network_mode == "testnet" {
                v1_msg_transmitter_testnet(domain).map(|s| s.to_string())
            } else {
                self.chains.get(&domain)
                    .and_then(|c| c.message_transmitter_v1.clone())
            }
        } else {
            None
        }
    }
}

// CCTP v1 contract addresses — per-chain (different from v2's unified address)
// Only 6 mainnet chains deployed v1: Ethereum(0), Avalanche(1), OP(2), Arbitrum(3), Base(6), Polygon(7)
fn v1_contracts(domain: i64) -> (Option<String>, Option<String>) {
    match domain {
        0 => (
            Some("0xBd3fa81B58Ba92a82136038B25aDec7066af3155".into()),
            Some("0x0a992d191DEeC32aFe36203Ad87D7d289a738F81".into()),
        ),
        1 => (
            Some("0x6B25532e1060CE10cc3B0A99e5683b91CDe25000".into()),
            Some("0x8186359aF5F57FbB40c6b14A5b5941C9Fb33c4eE".into()),
        ),
        2 => (
            Some("0x2B4069517957735bE00ceE0fadAE88a26365528f".into()),
            Some("0x4d41f22cA3881B48B55c77163D26BBe328557a7D".into()),
        ),
        3 => (
            Some("0x19330d10D9Cc8751218eaf51E8885D05864c2f89".into()),
            Some("0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca".into()),
        ),
        6 => (
            Some("0x1682Ae6375C4E4A97e4B583BC394c861A46d8962".into()),
            Some("0xAD09780d193884d503182aD4588450C416D6F9D4".into()),
        ),
        7 => (
            Some("0x9f3B8679c73C2Fef8b59B4f3444d4e156319e387".into()),
            Some("0xF3be9355363857F3e001be68856A2f96b4C39Ba9".into()),
        ),
        _ => (None, None),
    }
}

fn default_chains() -> Vec<ChainConfig> {
    vec![
        evm(0, "Ethereum", 1, "https://eth.llamarpc.com", "https://etherscan.io", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", true, true, 12000, 12),
        evm(1, "Avalanche", 43114, "https://api.avax.network/ext/bc/C/rpc", "https://snowtrace.io", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6e", false, true, 2000, 1),
        evm(2, "OP Mainnet", 10, "https://mainnet.optimism.io", "https://optimistic.etherscan.io", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", true, true, 2000, 1),
        evm(3, "Arbitrum", 42161, "https://arb1.arbitrum.io/rpc", "https://arbiscan.io", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", true, true, 250, 1),
        ChainConfig { domain: 5, name: "Solana".into(), chain_id: None, rpc_url: "https://api.mainnet-beta.solana.com".into(), explorer_url: "https://solscan.io".into(), usdc_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".into(), token_messenger_v2: "".into(), message_transmitter_v2: "".into(), token_messenger_v1: None, message_transmitter_v1: None, cctp_versions: vec![2], chain_type: ChainType::Solana, supports_fast_transfer: true, supports_forwarding: true, block_time_ms: 400, finality_blocks: 32 },
        evm(6, "Base", 8453, "https://mainnet.base.org", "https://basescan.org", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", true, true, 2000, 1),
        evm(7, "Polygon PoS", 137, "https://polygon-rpc.com", "https://polygonscan.com", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", false, true, 2000, 128),
        ChainConfig { domain: 8, name: "Sui".into(), chain_id: None, rpc_url: "https://fullnode.mainnet.sui.io:443".into(), explorer_url: "https://suiscan.xyz/mainnet/home".into(), usdc_address: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb845e24ff689::usdc::USDC".into(), token_messenger_v2: "0x63686576726f6e73000000000000000000000000000000000000000000000001".into(), message_transmitter_v2: "0x63686576726f6e73000000000000000000000000000000000000000000000002".into(), token_messenger_v1: None, message_transmitter_v1: None, cctp_versions: vec![2], chain_type: ChainType::Sui, supports_fast_transfer: false, supports_forwarding: false, block_time_ms: 2000, finality_blocks: 1 },
        evm(10, "Unichain", 130, "https://mainnet.unichain.org", "https://uniscan.io", "0x078D782b760474a361dDA0AF3839290b0EF57FEF", true, true, 1000, 1),
        evm(11, "Linea", 59144, "https://rpc.linea.build", "https://lineascan.build", "0x176211869cA2b568f2A7D4FC9456dB96d577A886", true, true, 12000, 1),
        evm(12, "Codex", 8333, "https://rpc.codex.xyz", "https://explorer.codex.xyz", "0xd54A9c321Ba676679b2B2D47C1d4ED5e1e1A98C6", true, true, 1000, 1),
        evm(13, "Sonic", 146, "https://rpc.soniclabs.com", "https://sonicscan.org", "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", false, true, 1000, 1),
        evm(33, "World Chain", 480, "https://worldchain-mainnet.g.alchemy.com/public", "https://worldscan.org", "0x79A02482A880bCE3F13e09Da970dC34db7CD1c73", true, true, 2000, 1),
        ChainConfig { domain: 14, name: "Aptos".into(), chain_id: None, rpc_url: "https://fullnode.mainnet.aptoslabs.com/v1".into(), explorer_url: "https://explorer.aptoslabs.com".into(), usdc_address: "0xbae204db268662167f40e43d77e93293d5588929d8cbee8b714e8304318ae11e::coin::T".into(), token_messenger_v2: "0x63686576726f6e73000000000000000000000000000000000000000000000001".into(), message_transmitter_v2: "0x63686576726f6e73000000000000000000000000000000000000000000000002".into(), token_messenger_v1: None, message_transmitter_v1: None, cctp_versions: vec![2], chain_type: ChainType::Aptos, supports_fast_transfer: true, supports_forwarding: false, block_time_ms: 1000, finality_blocks: 1 },
        evm(15, "Monad", 10143, "https://rpc.monad.xyz", "https://explorer.monad.xyz", "0x0000000000000000000000000000000000000000", false, true, 1000, 1),
        evm(16, "Sei", 1329, "https://evm-rpc.sei-apis.com", "https://seitrace.com", "0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1", false, true, 400, 1),
        evm(17, "BNB Smart Chain", 56, "https://bsc-dataseed1.binance.org", "https://bscscan.com", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", false, false, 3000, 15),
        evm(18, "XDC", 50, "https://rpc.xdcrpc.com", "https://xdcscan.io", "0xD4d0Fa7A8d71A7b29C154983a2066E682f4B3B4a", false, true, 2000, 1),
        evm(19, "HyperEVM", 999, "https://rpc.hyperliquid.xyz", "https://explorer.hyperliquid.xyz", "0x0000000000000000000000000000000000000000", false, true, 1000, 1),
        evm(21, "Ink", 57073, "https://rpc-gel.inkonchain.com", "https://explorer.inkonchain.com", "0x0000000000000000000000000000000000000000", true, true, 1000, 1),
        evm(22, "Plume", 98866, "https://rpc.plume.org", "https://explorer.plume.org", "0x0000000000000000000000000000000000000000", true, true, 1000, 1),
        ChainConfig { domain: 25, name: "Starknet".into(), chain_id: None, rpc_url: "https://starknet-mainnet.public.blastapi.io".into(), explorer_url: "https://starkscan.co".into(), usdc_address: "".into(), token_messenger_v2: "".into(), message_transmitter_v2: "".into(), token_messenger_v1: None, message_transmitter_v1: None, cctp_versions: vec![2], chain_type: ChainType::Starknet, supports_fast_transfer: true, supports_forwarding: false, block_time_ms: 2000, finality_blocks: 1 },
        evm(26, "Arc", 252, "https://rpc.arc.org", "https://explorer.arc.org", "0x0000000000000000000000000000000000000000", false, true, 1000, 1),
        ChainConfig { domain: 27, name: "Stellar".into(), chain_id: None, rpc_url: "https://horizon.stellar.org".into(), explorer_url: "https://stellar.expert/explorer/public".into(), usdc_address: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3THOJQHJMR5KTSLSQ".into(), token_messenger_v2: "".into(), message_transmitter_v2: "".into(), token_messenger_v1: None, message_transmitter_v1: None, cctp_versions: vec![2], chain_type: ChainType::Stellar, supports_fast_transfer: false, supports_forwarding: false, block_time_ms: 5000, finality_blocks: 1 },
        evm(28, "EDGE", 255, "https://rpc.edge.network", "https://explorer.edge.network", "0x0000000000000000000000000000000000000000", true, true, 1000, 1),
        evm(29, "Injective", 60808, "https://sentry.tm.injective.network", "https://explorer.injective.network", "0x0000000000000000000000000000000000000000", false, false, 1200, 1),
        evm(30, "Morph", 2818, "https://rpc.morphl2.io", "https://explorer.morphl2.io", "0x0000000000000000000000000000000000000000", true, false, 2000, 1),
        evm(31, "Pharos", 0, "https://rpc.pharos.org", "https://explorer.pharos.org", "0x0000000000000000000000000000000000000000", false, false, 2000, 1),
        evm(32, "Cronos", 25, "https://evm.cronos.org", "https://cronoscan.com", "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59", false, true, 6000, 1),
    ]
}

fn evm(
    domain: i64,
    name: &str,
    chain_id: u64,
    rpc: &str,
    explorer: &str,
    usdc: &str,
    fast: bool,
    fwd: bool,
    block_time: u64,
    finality: u32,
) -> ChainConfig {
    let (v1_tm, v1_mt) = v1_contracts(domain);
    let versions = if v1_tm.is_some() { vec![1, 2] } else { vec![2] };

    ChainConfig {
        domain,
        name: name.into(),
        chain_id: Some(chain_id),
        rpc_url: rpc.into(),
        explorer_url: explorer.into(),
        usdc_address: usdc.into(),
        token_messenger_v2: "0x28b5a0e9C2308A3d74BE81826939D71BC9371B2e".into(),
        message_transmitter_v2: "0x81D40F21F12A8F0E3252Bccb954D720d9770512A".into(),
        token_messenger_v1: v1_tm,
        message_transmitter_v1: v1_mt,
        cctp_versions: versions,
        chain_type: ChainType::Evm,
        supports_fast_transfer: fast,
        supports_forwarding: fwd,
        block_time_ms: block_time,
        finality_blocks: finality,
    }
}
