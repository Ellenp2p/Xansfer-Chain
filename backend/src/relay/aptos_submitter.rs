use anyhow::{anyhow, Result};
use aptos_sdk::{
    Aptos, AptosConfig,
    account::Ed25519Account,
    transaction::{Script, ScriptArgument, TransactionPayload},
};
use std::time::Duration;

/// Pre-compiled Move script that atomically executes the CCTP Aptos receive flow.
///
/// The script calls:
/// 1. `message_transmitter::receive_message(caller, &message, &attestation)` -> Receipt
/// 2. `token_messenger_minter::token_messenger::handle_receive_message(receipt)`
///
/// Step 3 (`message_transmitter::complete_receive_message`) is performed inside
/// `handle_receive_message`, which destroys the `Receipt` hot-potato object and
/// emits the `MessageReceived` event.
///
/// These bytecodes are taken from the official Circle `aptos-cctp` repository
/// (`typescript/example/precompiled-move-scripts/{testnet,mainnet}/handle_receive_message.mv`).
/// They embed the published package addresses, so only the well-known testnet
/// and mainnet package address pairs are supported out of the box.
const TESTNET_RECEIVE_SCRIPT: &[u8] =
    include_bytes!("aptos_scripts/testnet_handle_receive_message.mv");
const MAINNET_RECEIVE_SCRIPT: &[u8] =
    include_bytes!("aptos_scripts/mainnet_handle_receive_message.mv");

/// Known Circle CCTP Aptos package addresses.
const TESTNET_MESSAGE_TRANSMITTER: &str =
    "0x081e86cebf457a0c6004f35bd648a2794698f52e0dde09a48619dcd3d4cc23d9";
const TESTNET_TOKEN_MESSENGER_MINTER: &str =
    "0x5f9b937419dda90aa06c1836b7847f65bbbe3f1217567758dc2488be31a477b9";
const MAINNET_MESSAGE_TRANSMITTER: &str =
    "0x177e17751820e4b4371873ca8c30279be63bdea63b88ed0f2239c2eea10f1772";
const MAINNET_TOKEN_MESSENGER_MINTER: &str =
    "0x9bce6734f7b63e835108e3bd8c36743d4709fe435f44791918801d0989640a9d";

/// Submit a CCTP receive_message flow on Aptos.
///
/// Builds, signs, submits and waits for a Move script transaction that performs
/// the atomic CCTP receive flow. Only the official Circle CCTP testnet and
/// mainnet package address pairs are supported; the contract addresses are used
/// to select the matching pre-compiled script bytecode.
pub async fn submit_receive_message(
    rest_url: &str,
    message_transmitter: &str,
    token_messenger_minter: &str,
    private_key_hex: &str,
    message_hex: &str,
    attestation_hex: &str,
) -> Result<String> {
    // 1. Select the pre-compiled script for this network.
    let script_bytecode = select_receive_script(message_transmitter, token_messenger_minter)?;

    // 2. Create the Aptos client pointing at the supplied REST endpoint.
    let config = AptosConfig::custom(rest_url)
        .map_err(|e| anyhow!("invalid Aptos REST URL {rest_url}: {e}"))?;
    let aptos = Aptos::new(config)
        .map_err(|e| anyhow!("failed to create Aptos client: {e}"))?;

    // 3. Load the Ed25519 account from the supplied private key.
    let account = Ed25519Account::from_private_key_hex(private_key_hex)
        .map_err(|e| anyhow!("invalid Aptos private key: {e}"))?;

    // 4. Decode message and attestation from hex.
    let message = decode_hex(message_hex)
        .map_err(|e| anyhow!("invalid message hex: {e}"))?;
    let attestation = decode_hex(attestation_hex)
        .map_err(|e| anyhow!("invalid attestation hex: {e}"))?;

    // 5. Build the Move script payload.
    //    The script's `&signer` parameter is supplied automatically by the
    //    transaction sender; we only pass the two `vector<u8>` arguments.
    let script = Script::new(
        script_bytecode.to_vec(),
        vec![], // no type arguments
        vec![
            ScriptArgument::U8Vector(message),
            ScriptArgument::U8Vector(attestation),
        ],
    );
    let payload: TransactionPayload = script.into();

    // 6. Sign, submit and wait for on-chain commitment.
    let response = aptos
        .sign_submit_and_wait(&account, payload, Some(Duration::from_secs(60)))
        .await
        .map_err(|e| anyhow!("Aptos transaction failed: {e}"))?;

    // 7. Extract the transaction hash.
    let hash = response
        .data
        .get("hash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("transaction response missing hash"))?;

    Ok(hash.to_string())
}

/// Select the pre-compiled receive script bytecode by matching the supplied
/// contract addresses against the well-known Circle CCTP deployments.
fn select_receive_script(
    message_transmitter: &str,
    token_messenger_minter: &str,
) -> Result<&'static [u8]> {
    let mt = message_transmitter.trim().to_lowercase();
    let tmm = token_messenger_minter.trim().to_lowercase();

    if mt == TESTNET_MESSAGE_TRANSMITTER.to_lowercase()
        && tmm == TESTNET_TOKEN_MESSENGER_MINTER.to_lowercase()
    {
        return Ok(TESTNET_RECEIVE_SCRIPT);
    }

    if mt == MAINNET_MESSAGE_TRANSMITTER.to_lowercase()
        && tmm == MAINNET_TOKEN_MESSENGER_MINTER.to_lowercase()
    {
        return Ok(MAINNET_RECEIVE_SCRIPT);
    }

    Err(anyhow!(
        "unsupported CCTP Aptos package addresses. \
         Only Circle testnet ({}, {}) and mainnet ({}, {}) are supported. \
         For a custom deployment, provide a matching compiled Move script.",
        TESTNET_MESSAGE_TRANSMITTER,
        TESTNET_TOKEN_MESSENGER_MINTER,
        MAINNET_MESSAGE_TRANSMITTER,
        MAINNET_TOKEN_MESSENGER_MINTER,
    ))
}

/// Decode a hex string that may optionally start with "0x".
fn decode_hex(s: &str) -> Result<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).map_err(|e| anyhow!("hex decode error: {e}"))
}
