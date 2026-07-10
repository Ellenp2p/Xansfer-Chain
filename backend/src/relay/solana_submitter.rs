use anyhow::{anyhow, Result};

/// Submit a CCTP receiveMessage on Solana.
///
/// This requires constructing an Anchor instruction with the exact account
/// list from the MessageTransmitterV2 IDL and the TokenMessengerMinterV2
/// remaining accounts. Because the account derivation and IDL are
/// chain-specific, this is left as a targeted follow-up once the IDL / program
/// IDs are pinned.
#[allow(clippy::too_many_arguments)]
pub async fn submit_receive_message(
    _rpc_url: &str,
    _message_transmitter: &str,
    _token_messenger_minter: &str,
    _usdc_mint: &str,
    _keypair_bs58: &str,
    _message_hex: &str,
    _attestation_hex: &str,
    _recipient_token_account: &str,
    _source_domain: i64,
) -> Result<String> {
    Err(anyhow!(
        "Solana CCTP receiveMessage is not yet implemented. \
         V2 devnet program IDs: MessageTransmitterV2=CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC, \
         TokenMessengerMinterV2=CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"
    ))
}
