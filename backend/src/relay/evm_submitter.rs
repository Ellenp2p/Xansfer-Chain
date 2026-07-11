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
    /// Contract address the transaction is sent to (MessageTransmitter or Forwarder).
    to: String,
    /// Optional MessageTransmitter address used for `isMessageReceived` checks.
    message_transmitter: Option<String>,
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
        to: String,
        message_transmitter: Option<String>,
        key: EvmKey,
    ) -> Self {
        Self {
            rpc_url,
            chain_id,
            to,
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

    /// Submit CCTP `receiveMessage(bytes,bytes)` directly to MessageTransmitter
    /// and return the destination tx hash.
    pub async fn submit_receive_message(
        &self,
        message_hex: &str,
        attestation_hex: &str,
        block_time_ms: u64,
    ) -> Result<String> {
        let message = decode_hex(message_hex)?;
        let attestation = decode_hex(attestation_hex)?;

        let msg_hash = keccak256(&message);
        if let Some(mt) = self.message_transmitter.as_ref() {
            if self.is_message_received(&msg_hash, mt).await? {
                return Err(anyhow!("Message already claimed on destination chain"));
            }
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

    /// Submit a CCTP v2 Forwarder `mintAndForward(bytes,bytes,address,uint256)`
    /// call and return the destination tx hash.
    pub async fn submit_mint_and_forward(
        &self,
        message_hex: &str,
        attestation_hex: &str,
        recipient: &str,
        min_amount_out: u128,
        block_time_ms: u64,
    ) -> Result<String> {
        let message = decode_hex(message_hex)?;
        let attestation = decode_hex(attestation_hex)?;

        let recipient_address = decode_hex(recipient)?;
        if recipient_address.len() != 20 {
            return Err(anyhow!("Invalid recipient EVM address: {}", recipient));
        }

        let calldata = build_mint_and_forward_calldata(
            &message,
            &attestation,
            &recipient_address,
            min_amount_out,
        );
        let nonce = self.get_nonce().await?;
        let (raw_tx, tx_hash) = self.build_and_sign_tx(nonce, calldata).await?;

        info!(
            "Submitting mintAndForward from {}, recipient {}, tx hash: 0x{}",
            self.key.address_hex(),
            recipient,
            hex::encode(tx_hash)
        );

        self.send_raw_transaction(&raw_tx).await?;
        let receipt = self.wait_for_receipt(&tx_hash, block_time_ms).await?;

        let dest_hash = format!("0x{}", hex::encode(tx_hash));

        if let Some(status) = receipt.get("status").and_then(|s| s.as_str()) {
            let status_hex = status.strip_prefix("0x").unwrap_or(status);
            if status_hex == "0" {
                return Err(anyhow!(
                    "mintAndForward transaction reverted: {}",
                    dest_hash
                ));
            }
        }

        Ok(dest_hash)
    }

    /// Query the Forwarder contract's `previewForward(uint256)` view to obtain
    /// the fee and net amount for a given gross USDC amount. This lets the
    /// backend set an exact `minAmountOut` without knowing the on-chain fee
    /// model (percentage vs fixed) or caps.
    pub async fn preview_forward(&self, gross_amount: u128) -> Result<(u128, u128)> {
        let calldata = build_preview_forward_calldata(gross_amount);

        let params = json!([{
            "to": self.to,
            "data": format!("0x{}", hex::encode(&calldata)),
        }, "latest"]);

        let result = self.rpc_call("eth_call", params).await?;
        let result_str = result.as_str().ok_or_else(|| anyhow!("previewForward result not a string"))?;
        decode_u256_pair(result_str)
    }

    async fn rpc_call(&self,
        method: &str,
        params: Value,
    ) -> Result<Value> {
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

    async fn is_message_received(&self,
        message_hash: &[u8; 32],
        mt_address: &str,
    ) -> Result<bool> {
        let selector = keccak256_selector(b"isMessageReceived(bytes32)");
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&selector);
        calldata.extend_from_slice(message_hash);

        let params = json!([{
            "to": mt_address,
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
        let to = decode_hex(&self.to)?;
        if to.len() != 20 {
            return Err(anyhow!("Invalid destination contract address"));
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

/// Parse the USDC amount from a CCTP v2 message.
/// The amount field is located at byte offset 216 (148-byte header + 68-byte
/// body offset) and is encoded as a 32-byte big-endian uint256.
pub fn parse_cctp_v2_amount(message_hex: &str) -> Result<u128> {
    let bytes = decode_hex(message_hex)?;
    const AMOUNT_OFFSET: usize = 216;
    const AMOUNT_LEN: usize = 32;
    if bytes.len() < AMOUNT_OFFSET + AMOUNT_LEN {
        return Err(anyhow!(
            "CCTP v2 message too short to parse amount: {} bytes",
            bytes.len()
        ));
    }
    let amount_bytes: [u8; AMOUNT_LEN] = bytes[AMOUNT_OFFSET..AMOUNT_OFFSET + AMOUNT_LEN]
        .try_into()
        .map_err(|_| anyhow!("Failed to extract amount bytes"))?;
    // USDC amounts fit comfortably in u128; reject if high 16 bytes are non-zero.
    if amount_bytes[..16] != [0u8; 16] {
        return Err(anyhow!("CCTP v2 amount exceeds u128 range"));
    }
    Ok(u128::from_be_bytes(amount_bytes[16..].try_into().unwrap()))
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

fn build_mint_and_forward_calldata(
    message: &[u8],
    attestation: &[u8],
    recipient: &[u8],
    min_amount_out: u128,
) -> Vec<u8> {
    // mintAndForward(bytes,bytes,address,uint256)
    let selector = keccak256_selector(b"mintAndForward(bytes,bytes,address,uint256)");
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&selector);

    // ABI encoding for (bytes, bytes, address, uint256):
    // offset to first bytes  (32)
    // offset to second bytes (32)
    // recipient address      (32)
    // minAmountOut           (32)
    // first bytes length     (32)
    // first bytes data       (padded)
    // second bytes length    (32)
    // second bytes data      (padded)
    let offset1 = 128u64; // 4 static args * 32
    let offset2 = offset1 + 32 + padded_len(message.len()) as u64;

    encoded.extend_from_slice(&u256_bytes(offset1));
    encoded.extend_from_slice(&u256_bytes(offset2));

    // recipient address (20 bytes zero-padded to 32)
    let mut recipient_padded = [0u8; 32];
    recipient_padded[12..].copy_from_slice(recipient);
    encoded.extend_from_slice(&recipient_padded);

    // minAmountOut as uint256
    let mut min_amount_bytes = [0u8; 32];
    min_amount_bytes[16..].copy_from_slice(&min_amount_out.to_be_bytes());
    encoded.extend_from_slice(&min_amount_bytes);

    // message bytes
    encoded.extend_from_slice(&u256_bytes(message.len() as u64));
    encoded.extend_from_slice(message);
    encoded.extend_from_slice(&padding(message.len()));

    // attestation bytes
    encoded.extend_from_slice(&u256_bytes(attestation.len() as u64));
    encoded.extend_from_slice(attestation);
    encoded.extend_from_slice(&padding(attestation.len()));

    encoded
}

fn build_preview_forward_calldata(gross_amount: u128) -> Vec<u8> {
    // previewForward(uint256)
    let selector = keccak256_selector(b"previewForward(uint256)");
    let mut encoded = Vec::with_capacity(36);
    encoded.extend_from_slice(&selector);
    encoded.extend_from_slice(&u256_from_u128(gross_amount));
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

fn u256_from_u128(v: u128) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(&v.to_be_bytes());
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

/// Decode a pair of uint256 values returned by an ABI view function.
fn decode_u256_pair(result_hex: &str) -> Result<(u128, u128)> {
    let bytes = decode_hex(result_hex)?;
    if bytes.len() < 64 {
        return Err(anyhow!("decode_u256_pair: result too short ({} bytes)", bytes.len()));
    }

    let fee = u256_to_u128(&bytes[0..32])?;
    let net = u256_to_u128(&bytes[32..64])?;
    Ok((fee, net))
}

fn u256_to_u128(bytes: &[u8]) -> Result<u128> {
    if bytes.len() != 32 {
        return Err(anyhow!("u256_to_u128 expected 32 bytes, got {}", bytes.len()));
    }
    if bytes[..16] != [0u8; 16] {
        return Err(anyhow!("u256 value exceeds u128 range"));
    }
    Ok(u128::from_be_bytes(bytes[16..32].try_into().unwrap()))
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
    r_bytes.copy_from_slice(r.to_bytes().as_ref());
    s_bytes.copy_from_slice(s.to_bytes().as_ref());

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
    fn test_mint_and_forward_selector() {
        let sel = keccak256_selector(b"mintAndForward(bytes,bytes,address,uint256)");
        assert_eq!(hex::encode(sel), "adc33b96");
    }

    #[test]
    fn test_build_mint_and_forward_calldata_encoding() {
        let message = vec![0xab; 33];
        let attestation = vec![0xcd; 65];
        let recipient = vec![0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34,
                             0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78];
        let min_amount_out = 1_000_000u128;
        let calldata = build_mint_and_forward_calldata(
            &message, &attestation, &recipient, min_amount_out,
        );

        assert_eq!(
            &calldata[0..4],
            keccak256_selector(b"mintAndForward(bytes,bytes,address,uint256)")
        );
        // offset1 = 128
        assert_eq!(&calldata[4..36], u256_bytes(128));
        let offset2 = 128 + 32 + padded_len(message.len());
        assert_eq!(&calldata[36..68], u256_bytes(offset2 as u64));
        // recipient at index 68..100, last 20 bytes should match
        assert_eq!(&calldata[80..100],
            &[0x12u8, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34,
                0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78]
        );
        // minAmountOut is at index 100..132; high 16 bytes are zero, low 16 bytes hold the value
        let low_bytes: [u8; 16] = calldata[116..132].try_into().unwrap();
        assert_eq!(u128::from_be_bytes(low_bytes), min_amount_out);
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
