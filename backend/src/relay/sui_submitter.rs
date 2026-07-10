use anyhow::{anyhow, Result};

/// Submit a CCTP receive_message on Sui.
///
/// Sui requires a Programmable Transaction Block (PTB) with two Move calls:
/// 1. `{message_transmitter_package}::receive_message::receive_message(...)`
/// 2. `{token_messenger_minter_package}::handle_receive_message::handle_receive_message(...)`
///
/// The exact package/object IDs must come from the Circle Sui testnet branch
/// (see https://github.com/circlefin/sui-cctp/tree/testnet).
#[allow(clippy::too_many_arguments)]
pub async fn submit_receive_message(
    _rpc_url: &str,
    _message_transmitter_package: &str,
    _token_messenger_minter_package: &str,
    _message_transmitter_state: &str,
    _token_messenger_minter_state: &str,
    _private_key_hex: &str,
    _message_hex: &str,
    _attestation_hex: &str,
) -> Result<String> {
    Err(anyhow!(
        "Sui CCTP receive_message is not yet implemented. \
         Fetch the testnet package/object IDs from https://github.com/circlefin/sui-cctp/tree/testnet"
    ))
}
