use anyhow::{anyhow, Result};

/// Submit a CCTP receive_message flow on Aptos.
///
/// Aptos requires a single transaction (or Move script) that atomically calls:
/// 1. `message_transmitter::receive_message(message, attestation)` -> Receipt
/// 2. `token_messenger_minter::handle_receive_message(Receipt)`
/// 3. `message_transmitter::complete_receive_message(Receipt)`
///
/// Testnet addresses are documented at
/// https://developers.circle.com/cctp/aptos-packages.
pub async fn submit_receive_message(
    _rest_url: &str,
    _message_transmitter: &str,
    _token_messenger_minter: &str,
    _private_key_hex: &str,
    _message_hex: &str,
    _attestation_hex: &str,
) -> Result<String> {
    Err(anyhow!(
        "Aptos CCTP receive_message is not yet implemented. \
         Testnet MessageTransmitter package: 0x081e86cebf457a0c6004f35bd648a2794698f52e0dde09a48619dcd3d4cc23d9, \
         TokenMessengerMinter package: 0x5f9b937419dda90aa06c1836b7847f65bbbe3f1217567758dc2488be31a477b9"
    ))
}
