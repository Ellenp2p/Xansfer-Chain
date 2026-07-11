use std::time::Duration;

use anyhow::{anyhow, Result};
use soroban_client::{
    contract::{ContractBehavior, Contracts},
    keypair::{Keypair, KeypairBehavior},
    network::{NetworkPassphrase, Networks},
    soroban_rpc::{SendTransactionStatus, TransactionStatus},
    transaction::{TransactionBehavior, TransactionBuilderBehavior},
    transaction_builder::TransactionBuilder,
    xdr::{ScBytes, ScVal},
    Options, Server,
};

/// Submit a CCTP receive_message on Stellar Soroban.
///
/// The `message_transmitter` argument is the Soroban contract address (e.g.
/// `CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY` on testnet).
/// If a forward recipient is involved, `forwarder` should be the
/// `CctpForwarder` contract address.
///
/// # Implementation notes
///
/// * `secret_key` is parsed as a Stellar `S...` secret key.
/// * The transaction is simulated, assembled, signed, submitted and then
///   polled until it reaches a terminal status.
/// * The network passphrase is currently hard-coded to Stellar testnet because
///   the relay worker only wires this function for testnet today.  Mainnet
///   contract addresses can already be passed via `message_transmitter` and
///   `forwarder`; switching the signing network for mainnet is left as a
///   follow-up.
pub async fn submit_receive_message(
    rpc_url: &str,
    message_transmitter: &str,
    forwarder: Option<&str>,
    secret_key: &str,
    message_hex: &str,
    attestation_hex: &str,
    network_mode: &str,
) -> Result<String> {
    // Decode the CCTP message and attestation from hex into Soroban Bytes.
    let message = hex::decode(message_hex).map_err(|e| anyhow!("invalid message hex: {e}"))?;
    let attestation =
        hex::decode(attestation_hex).map_err(|e| anyhow!("invalid attestation hex: {e}"))?;

    let message_val = ScVal::Bytes(
        ScBytes::try_from(message).map_err(|e| anyhow!("invalid message bytes: {e}"))?,
    );
    let attestation_val = ScVal::Bytes(
        ScBytes::try_from(attestation).map_err(|e| anyhow!("invalid attestation bytes: {e}"))?,
    );

    // Route through the forwarder when requested, otherwise call the
    // MessageTransmitter directly.
    let (contract_id, function) = if let Some(forwarder_addr) = forwarder {
        (forwarder_addr, "mint_and_forward")
    } else {
        (message_transmitter, "receive_message")
    };

    let contract = Contracts::new(contract_id)
        .map_err(|e| anyhow!("invalid Stellar contract address {contract_id}: {e}"))?;
    let op = contract.call(function, Some(vec![message_val, attestation_val]));

    // Connect to RPC and load the signing account.
    let rpc = Server::new(rpc_url, Options::default())
        .map_err(|e| anyhow!("failed to create Soroban RPC client: {e}"))?;
    let keypair = Keypair::from_secret(secret_key)
        .map_err(|e| anyhow!("failed to load Stellar keypair: {e}"))?;
    let mut account = rpc
        .get_account(&keypair.public_key())
        .await
        .map_err(|e| anyhow!("failed to fetch source account from RPC: {e}"))?;

    // Build the transaction, simulate to get resource/fees, then sign.
    let network = if network_mode == "testnet" {
        Networks::testnet()
    } else {
        Networks::public()
    };
    let mut tx = TransactionBuilder::new(&mut account, network, None)
        .fee(1000u32)
        .set_timeout(30)
        .map_err(|e| anyhow!("failed to set transaction timeout: {e}"))?
        .add_operation(op)
        .build();

    tx = rpc
        .prepare_transaction(&tx)
        .await
        .map_err(|e| anyhow!("failed to prepare/simulate transaction: {e}"))?;

    tx.sign(&[keypair]);

    // Submit and wait for a terminal status.
    let send_response = rpc
        .send_transaction(tx)
        .await
        .map_err(|e| anyhow!("failed to send transaction: {e}"))?;

    match send_response.status {
        SendTransactionStatus::Pending | SendTransactionStatus::Duplicate => {}
        _ => {
            return Err(anyhow!(
                "send_transaction returned status {:?} for hash {}",
                send_response.status,
                send_response.hash
            ));
        }
    }

    let hash = send_response.hash;
    let tx_response = rpc
        .wait_transaction(&hash, Duration::from_secs(60))
        .await
        .map_err(|(e, last)| match last {
            Some(last) => anyhow!(
                "error while waiting for transaction {hash} (status {:?}): {e}",
                last.status
            ),
            None => anyhow!("error while waiting for transaction {hash}: {e}"),
        })?;

    match tx_response.status {
        TransactionStatus::Success => Ok(hash),
        TransactionStatus::Failed => Err(anyhow!("transaction {hash} failed on-chain")),
        TransactionStatus::NotFound => Err(anyhow!(
            "transaction {hash} was submitted but not found while polling"
        )),
    }
}
