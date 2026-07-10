use anyhow::{anyhow, Result};
use k256::ecdsa::SigningKey;
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tiny_keccak::{Hasher, Keccak};
use tracing::{debug, info, warn};

#[derive(Debug, Clone)]
pub struct EvmKey {
    pub secret: [u8; 32],
    pub address: [u8; 20],
}

impl EvmKey {
    pub fn from_hex(hex_str: &str) -> Result<Self> {
        let hex = hex_str.strip_prefix("0x").unwrap_or(hex_str);
        let mut secret = [0u8; 32];
        hex::decode_to_slice(hex, &mut secret)
            .map_err(|e| anyhow!("Invalid EVM private key hex: {e}"))?;

        let signing_key = SigningKey::from_bytes((&secret).into())?;
        let verifying_key = signing_key.verifying_key();
        let pubkey_bytes = verifying_key.to_encoded_point(false).as_bytes().to_vec();
        // Ethereum address = last 20 bytes of keccak256(uncompressed pubkey without 0x04 prefix)
        let hash = keccak256(&pubkey_bytes[1..]);
        let mut address = [0u8; 20];
        address.copy_from_slice(&hash[12..]);

        Ok(Self { secret, address })
    }

    pub fn address_hex(&self) -> String {
        format!("0x{}", hex::encode(self.address))
    }
}

#[derive(Debug, Clone)]
pub struct EvmSubmitter {
    rpc_url: String,
    chain_id: u64,
    message_transmitter: String,
    key: EvmKey,
    client: Client,
    gas_limit: u64,
    max_gas_price_gwei: Option<u64>,
    max_priority_fee_gwei: Option<u64>,
    tx_timeout_secs: u64,
}

impl EvmSubmitter {
    pub fn new(
        rpc_url: String,
        chain_id: u64,
        message_transmitter: String,
        key: EvmKey,
    ) -> Self {
        Self {
            rpc_url,
            chain_id,
            message_transmitter,
            key,
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("HTTP client"),
            gas_limit: std::env::var("RELAY_EVM_GAS_LIMIT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(200_000),
            max_gas_price_gwei: std::env::var("RELAY_MAX_GAS_PRICE_GWEI")
                .ok()
                .and_then(|s| s.parse().ok()),
            max_priority_fee_gwei: std::env::var("RELAY_MAX_PRIORITY_FEE_GWEI")
                .ok()
                .and_then(|s| s.parse().ok()),
            tx_timeout_secs: std::env::var("RELAY_TX_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300),
        }
    }

    /// Submit CCTP receiveMessage(bytes,bytes) and return the destination tx hash.
    pub async fn submit_receive_message(
        &self,
        message_hex: &str,
        attestation_hex: &str,
        block_time_ms: u64,
    ) -> Result<String> {
        let message = decode_hex(message_hex)?;
        let attestation = decode_hex(attestation_hex)?;

        let msg_hash = keccak256(&message);
        if self.is_message_received(&msg_hash).await? {
            return Err(anyhow!("Message already claimed on destination chain"));
        }

        let calldata = build_receive_message_calldata(&message, &attestation);
        let nonce = self.get_nonce().await?;
        let (raw_tx, tx_hash) = self.build_and_sign_tx(nonce, calldata).await?;

        info!(
            "Submitting receiveMessage from {}, tx hash: 0x{}",
            self.key.address_hex(),
            hex::encode(tx_hash)
        );

        self.send_raw_transaction(&raw_tx).await?;
        let receipt = self.wait_for_receipt(&tx_hash, block_time_ms).await?;

        let dest_hash = format!("0x{}", hex::encode(tx_hash));

        if let Some(status) = receipt.get("status").and_then(|s| s.as_str()) {
            let status_hex = status.strip_prefix("0x").unwrap_or(status);
            if status_hex == "0" {
                return Err(anyhow!(
                    "receiveMessage transaction reverted: {}",
                    dest_hash
                ));
            }
        }

        Ok(dest_hash)
    }

    async fn rpc_call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1,
        });

        debug!("RPC {} -> {}", method, self.rpc_url);

        let resp = self.client.post(&self.rpc_url).json(&body).send().await?;

        if !resp.status().is_success() {
            return Err(anyhow!("RPC {} returned HTTP {}", method, resp.status()));
        }

        let result: Value = resp.json().await?;
        if let Some(err) = result.get("error") {
            return Err(anyhow!("RPC {} error: {}", method, err));
        }

        Ok(result["result"].clone())
    }

    async fn is_message_received(&self, message_hash: &[u8; 32]) -> Result<bool> {
        let selector = keccak256_selector(b"isMessageReceived(bytes32)");
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&selector);
        calldata.extend_from_slice(message_hash);

        let params = json!([{
            "to": self.message_transmitter,
            "data": format!("0x{}", hex::encode(&calldata)),
        }, "latest"]);

        let result = self.rpc_call("eth_call", params).await?;
        let result_str = result.as_str().unwrap_or("0x");
        let hex = result_str.strip_prefix("0x").unwrap_or(result_str);
        if hex.len() >= 64 {
            Ok(&hex[hex.len() - 2..] != "00")
        } else {
            Ok(false)
        }
    }

    async fn get_nonce(&self) -> Result<u64> {
        let params = json!([self.key.address_hex(), "pending"]);
        let result = self.rpc_call("eth_getTransactionCount", params).await?;
        let hex = result.as_str().ok_or_else(|| anyhow!("nonce not a string"))?;
        parse_hex_u64(hex)
    }

    async fn build_and_sign_tx(
        &self,
        nonce: u64,
        data: Vec<u8>,
    ) -> Result<(Vec<u8>, [u8; 32])> {
        let to = decode_hex(&self.message_transmitter)?;
        if to.len() != 20 {
            return Err(anyhow!("Invalid message transmitter address"));
        }
        let to_arr: [u8; 20] = to.try_into().unwrap();

        // Try EIP-1559 first
        let max_priority_fee = self.get_max_priority_fee().await?;
        let supports_eip1559 = max_priority_fee.is_some();

        let (raw_tx, tx_hash): (Vec<u8>, [u8; 32]);

        if supports_eip1559 {
            let max_priority = max_priority_fee.unwrap();
            let max_fee = self.get_max_fee_per_gas(max_priority).await?;
            let chain_id = self.chain_id;

            let mut unsigned = rlp::RlpStream::new_list(9);
            unsigned
                .append(&chain_id)
                .append(&nonce)
                .append(&max_priority)
                .append(&max_fee)
                .append(&self.gas_limit)
                .append(&to_arr.as_slice())
                .append(&0u64) // value
                .append(&data.as_slice())
                .append_raw(&rlp::RlpStream::new_list(0).out(), 1); // empty access list

            let sig = sign_hash(&eip1559_signing_hash(&unsigned.out()),
                &self.key.secret,
            )?;

            let mut signed = rlp::RlpStream::new_list(12);
            signed
                .append(&chain_id)
                .append(&nonce)
                .append(&max_priority)
                .append(&max_fee)
                .append(&self.gas_limit)
                .append(&to_arr.as_slice())
                .append(&0u64)
                .append(&data.as_slice())
                .append_raw(&rlp::RlpStream::new_list(0).out(), 1)
                .append(&sig.v)
                .append(&sig.r.as_slice())
                .append(&sig.s.as_slice());

            raw_tx = wrap_tx_type(2, &signed.out());
            tx_hash = keccak256(&raw_tx);
        } else {
            let gas_price = self.get_gas_price().await?;
            let chain_id = self.chain_id;

            let mut unsigned = rlp::RlpStream::new_list(9);
            unsigned
                .append(&nonce)
                .append(&gas_price)
                .append(&self.gas_limit)
                .append(&to_arr.as_slice())
                .append(&0u64)
                .append(&data.as_slice())
                .append(&chain_id)
                .append(&0u8)
                .append(&0u8);

            let sig = sign_hash(
                &keccak256(&unsigned.out()),
                &self.key.secret,
            )?;
            let v = chain_id * 2 + 35 + sig.v;

            let mut signed = rlp::RlpStream::new_list(9);
            signed
                .append(&nonce)
                .append(&gas_price)
                .append(&self.gas_limit)
                .append(&to_arr.as_slice())
                .append(&0u64)
                .append(&data.as_slice())
                .append(&v)
                .append(&sig.r.as_slice())
                .append(&sig.s.as_slice());

            raw_tx = signed.out().to_vec();
            tx_hash = keccak256(&raw_tx);
        }

        Ok((raw_tx, tx_hash))
    }

    async fn get_max_priority_fee(&self,
    ) -> Result<Option<u64>> {
        let result = self.rpc_call("eth_maxPriorityFeePerGas", json!([])).await;
        match result {
            Ok(Value::String(hex)) => {
                let mut fee = parse_hex_u64(&hex)?;
                if let Some(cap) = self.max_priority_fee_gwei {
                    let cap_wei = cap * 1_000_000_000;
                    fee = fee.min(cap_wei);
                }
                Ok(Some(fee))
            }
            _ => Ok(None),
        }
    }

    async fn get_max_fee_per_gas(&self, max_priority: u64) -> Result<u64> {
        let base_fee = self.get_base_fee().await.unwrap_or(0);
        let max_fee = base_fee * 2 + max_priority;
        if let Some(cap) = self.max_gas_price_gwei {
            let cap_wei = cap * 1_000_000_000;
            Ok(max_fee.min(cap_wei))
        } else {
            Ok(max_fee)
        }
    }

    async fn get_base_fee(&self) -> Result<u64> {
        let block = self
            .rpc_call("eth_getBlockByNumber", json!(["latest", false]))
            .await?;
        let base_fee_hex = block
            .get("baseFeePerGas")
            .and_then(|v| v.as_str())
            .unwrap_or("0x0");
        parse_hex_u64(base_fee_hex)
    }

    async fn get_gas_price(&self) -> Result<u64> {
        let result = self.rpc_call("eth_gasPrice", json!([])).await?;
        let hex = result
            .as_str()
            .ok_or_else(|| anyhow!("gasPrice not string"))?;
        let mut price = parse_hex_u64(hex)?;
        if let Some(cap) = self.max_gas_price_gwei {
            let cap_wei = cap * 1_000_000_000;
            price = price.min(cap_wei);
        }
        Ok(price)
    }

    async fn send_raw_transaction(&self, raw_tx: &[u8]) -> Result<()> {
        let hex = format!("0x{}", hex::encode(raw_tx));
        let _ = self.rpc_call("eth_sendRawTransaction", json!([hex])).await?;
        Ok(())
    }

    async fn wait_for_receipt(
        &self,
        tx_hash: &[u8; 32],
        block_time_ms: u64,
    ) -> Result<Value> {
        let hash_hex = format!("0x{}", hex::encode(tx_hash));
        let start = std::time::Instant::now();
        let sleep = Duration::from_millis(block_time_ms.max(1000));
        let timeout = Duration::from_secs(self.tx_timeout_secs);

        loop {
            if start.elapsed() > timeout {
                return Err(anyhow!("Timeout waiting for receipt: {}", hash_hex));
            }

            let result = self
                .rpc_call("eth_getTransactionReceipt", json!([hash_hex]))
                .await;

            match result {
                Ok(Value::Null) => {}
                Ok(receipt) => {
                    if receipt.get("blockHash").is_some() {
                        return Ok(receipt);
                    }
                }
                Err(e) => {
                    warn!("Error fetching receipt for {}: {}", hash_hex, e);
                }
            }

            tokio::time::sleep(sleep).await;
        }
    }
}

fn build_receive_message_calldata(message: &[u8], attestation: &[u8]) -> Vec<u8> {
    let selector = keccak256_selector(b"receiveMessage(bytes,bytes)");
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&selector);

    // ABI encode (bytes, bytes):
    // offset1 (32), offset2 (32), length1 (32), data1, length2 (32), data2
    let offset1 = 64u64; // first bytes arg starts at byte 64 (after 2 offsets)
    let offset2 = 64 + 32 + padded_len(message.len()) as u64;

    encoded.extend_from_slice(&u256_bytes(offset1));
    encoded.extend_from_slice(&u256_bytes(offset2));
    encoded.extend_from_slice(&u256_bytes(message.len() as u64));
    encoded.extend_from_slice(message);
    encoded.extend_from_slice(&padding(message.len()));
    encoded.extend_from_slice(&u256_bytes(attestation.len() as u64));
    encoded.extend_from_slice(attestation);
    encoded.extend_from_slice(&padding(attestation.len()));

    encoded
}

fn padded_len(len: usize) -> usize {
    len.div_ceil(32) * 32
}

fn padding(len: usize) -> Vec<u8> {
    vec![0u8; padded_len(len) - len]
}

fn u256_bytes(v: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&v.to_be_bytes());
    b
}

fn decode_hex(s: &str) -> Result<Vec<u8>> {
    let hex = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(hex).map_err(|e| anyhow!("hex decode error: {e}"))
}

fn parse_hex_u64(s: &str) -> Result<u64> {
    let hex = s.strip_prefix("0x").unwrap_or(s);
    u64::from_str_radix(hex, 16)
        .map_err(|e| anyhow!("Failed to parse hex u64 '{}': {}", s, e))
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    let mut output = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut output);
    output
}

fn keccak256_selector(sig: &[u8]) -> [u8; 4] {
    let hash = keccak256(sig);
    [hash[0], hash[1], hash[2], hash[3]]
}

fn eip1559_signing_hash(encoded_unsigned: &[u8]) -> [u8; 32] {
    let mut prefixed = vec![0x02];
    prefixed.extend_from_slice(encoded_unsigned);
    keccak256(&prefixed)
}

fn wrap_tx_type(tx_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![tx_type];
    out.extend_from_slice(payload);
    out
}

struct Sig {
    v: u64,
    r: [u8; 32],
    s: [u8; 32],
}

fn sign_hash(hash: &[u8; 32], secret: &[u8; 32]) -> Result<Sig> {
    let signing_key = SigningKey::from_bytes(secret.into())?;
    let (sig, recid) = signing_key.sign_prehash_recoverable(hash)?;
    let (r, s) = sig.split_scalars();

    let mut r_bytes = [0u8; 32];
    let mut s_bytes = [0u8; 32];
    r_bytes.copy_from_slice(r.to_bytes().as_slice());
    s_bytes.copy_from_slice(s.to_bytes().as_slice());

    Ok(Sig {
        v: recid.to_byte() as u64,
        r: r_bytes,
        s: s_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_receive_message_selector() {
        let sel = keccak256_selector(b"receiveMessage(bytes,bytes)");
        assert_eq!(hex::encode(sel), "57ecfd28");
    }

    #[test]
    fn test_evm_key_address() {
        // Well-known test vector: private key 1 -> address 0x7E5F4552091A69125d5Dfcb7b8C2659029395Bdf
        let key = EvmKey::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        assert_eq!(
            key.address_hex(),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn test_build_calldata_encoding() {
        let message = vec![0xab; 33];
        let attestation = vec![0xcd; 65];
        let calldata = build_receive_message_calldata(&message, &attestation);

        assert_eq!(&calldata[0..4], keccak256_selector(b"receiveMessage(bytes,bytes)"));
        // Two offsets
        assert_eq!(&calldata[4..36], u256_bytes(64));
        let offset2 = 64 + 32 + padded_len(message.len());
        assert_eq!(&calldata[36..68], u256_bytes(offset2 as u64));
    }
}
