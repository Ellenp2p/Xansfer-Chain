use anyhow::{anyhow, Result};

/// Submit a CCTP receive_message on Stellar Soroban.
///
/// The `message_transmitter` argument is the Soroban contract address (e.g.
/// `CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY` on testnet).
/// If a forward recipient is involved, `forwarder` should be the
/// `CctpForwarder` contract address.
pub async fn submit_receive_message(
    _rpc_url: &str,
    _message_transmitter: &str,
    _forwarder: Option<&str>,
    _secret_key: &str,
    _message_hex: &str,
    _attestation_hex: &str,
) -> Result<String> {
    Err(anyhow!(
        "Stellar CCTP receive_message is not yet implemented. \
         Testnet MessageTransmitter contract: CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY"
    ))
}
