use anyhow::{anyhow, Result};
use ed25519_dalek::Signer;
use std::str::FromStr;
use std::time::Duration;
use sui_rpc::proto::sui::rpc::v2::{
    ExecuteTransactionRequest, GetObjectRequest, UserSignature as ProtoUserSignature,
};
use sui_sdk_types::{
    Address, Ed25519PublicKey, Ed25519Signature, Identifier, SimpleSignature, StructTag,
    Transaction, UserSignature,
};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};

/// Submit a CCTP receive_message on Sui.
///
/// Builds and signs a PTB with the full CCTP receive flow:
/// 1. `{message_transmitter_package}::receive_message::receive_message(message, attestation, &state)`
/// 2. `{token_messenger_minter_package}::handle_receive_message::handle_receive_message<T>(receipt, &state, &deny_list, &treasury)`
/// 3. `{token_messenger_minter_package}::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message(ticket_with_burn_message)`
/// 4. `{message_transmitter_package}::receive_message::stamp_receipt<{token_messenger_minter_package}::message_transmitter_authenticator::MessageTransmitterAuthenticator>(stamp_receipt_ticket, &state)`
/// 5. `{message_transmitter_package}::receive_message::complete_receive_message(stamped_receipt, &state)`
///
/// Additional object IDs and the USDC type tag are read from environment variables:
/// - `SUI_USDC_TYPE_TAG`: e.g. `0x3a915322...::usdc::USDC`
/// - `SUI_DENY_LIST`: DenyList shared object ID for the USDC token
/// - `SUI_TREASURY`: Treasury shared object ID for the USDC token
#[allow(clippy::too_many_arguments)]
pub async fn submit_receive_message(
    rpc_url: &str,
    message_transmitter_package: &str,
    token_messenger_minter_package: &str,
    message_transmitter_state: &str,
    token_messenger_minter_state: &str,
    private_key_hex: &str,
    message_hex: &str,
    attestation_hex: &str,
) -> Result<String> {
    // Decode hex inputs.
    let private_key_hex = private_key_hex.strip_prefix("0x").unwrap_or(private_key_hex);
    let private_key_bytes = hex::decode(private_key_hex)?;
    if private_key_bytes.len() != 32 {
        return Err(anyhow!(
            "Sui private key must be 32 bytes (64 hex chars), got {}",
            private_key_bytes.len()
        ));
    }

    let signing_key = ed25519_dalek::SigningKey::from_bytes(
        &private_key_bytes
            .try_into()
            .map_err(|_| anyhow!("failed to convert private key to array"))?,
    );
    let verifying_key = signing_key.verifying_key();
    let public_key = Ed25519PublicKey::new(verifying_key.to_bytes());
    let sender = public_key.derive_address();

    let message = hex::decode(message_hex.strip_prefix("0x").unwrap_or(message_hex))?;
    let attestation = hex::decode(attestation_hex.strip_prefix("0x").unwrap_or(attestation_hex))?;

    // Parse package and state object addresses.
    let message_transmitter_package = Address::from_str(message_transmitter_package)
        .map_err(|e| anyhow!("invalid message_transmitter_package: {e}"))?;
    let token_messenger_minter_package = Address::from_str(token_messenger_minter_package)
        .map_err(|e| anyhow!("invalid token_messenger_minter_package: {e}"))?;

    // Read additional CCTP object IDs from environment.
    let usdc_type_tag = std::env::var("SUI_USDC_TYPE_TAG")
        .map_err(|_| anyhow!("SUI_USDC_TYPE_TAG env var not set"))?
        .parse::<StructTag>()
        .map_err(|e| anyhow!("invalid SUI_USDC_TYPE_TAG: {e}"))?;
    let deny_list_id = std::env::var("SUI_DENY_LIST")
        .map_err(|_| anyhow!("SUI_DENY_LIST env var not set"))?;
    let treasury_id = std::env::var("SUI_TREASURY")
        .map_err(|_| anyhow!("SUI_TREASURY env var not set"))?;

    // Connect to Sui RPC.
    let mut client = sui_rpc::Client::new(rpc_url)
        .map_err(|e| anyhow!("failed to create Sui RPC client: {e}"))?;

    // Resolve shared-object inputs with current versions from the node.
    let message_transmitter_state_obj =
        fetch_shared_object_input(&mut client, message_transmitter_state, true).await?;
    let token_messenger_minter_state_obj =
        fetch_shared_object_input(&mut client, token_messenger_minter_state, true).await?;
    let deny_list_obj = fetch_shared_object_input(&mut client, &deny_list_id, false).await?;
    let treasury_obj = fetch_shared_object_input(&mut client, &treasury_id, true).await?;

    // Build the PTB.
    let mut tx = TransactionBuilder::new();

    let message_arg = tx.pure(&message);
    let attestation_arg = tx.pure(&attestation);
    let mt_state_arg = tx.object(message_transmitter_state_obj);

    let receipt = tx.move_call(
        Function::new(
            message_transmitter_package,
            Identifier::from_str("receive_message")?,
            Identifier::from_str("receive_message")?,
        ),
        vec![message_arg, attestation_arg, mt_state_arg],
    );

    let tmm_state_arg = tx.object(token_messenger_minter_state_obj);
    let deny_list_arg = tx.object(deny_list_obj);
    let treasury_arg = tx.object(treasury_obj);

    let stamp_receipt_ticket_with_burn_message = tx.move_call(
        Function::new(
            token_messenger_minter_package,
            Identifier::from_str("handle_receive_message")?,
            Identifier::from_str("handle_receive_message")?,
        )
        .with_type_args(vec![usdc_type_tag.into()]),
        vec![receipt, tmm_state_arg, deny_list_arg, treasury_arg],
    );

    // Deconstruct the hot-potato ticket. `BurnMessage` has `drop` and is ignored.
    let stamp_receipt_ticket = tx
        .move_call(
            Function::new(
                token_messenger_minter_package,
                Identifier::from_str("handle_receive_message")?,
                Identifier::from_str("deconstruct_stamp_receipt_ticket_with_burn_message")?,
            ),
            vec![stamp_receipt_ticket_with_burn_message],
        )
        .to_nested(2)[0];

    let authenticator_type_tag = format!(
        "{}::message_transmitter_authenticator::MessageTransmitterAuthenticator",
        token_messenger_minter_package
    )
    .parse::<StructTag>()
    .map_err(|e| anyhow!("invalid MessageTransmitterAuthenticator type tag: {e}"))?
    .into();

    let stamped_receipt = tx.move_call(
        Function::new(
            message_transmitter_package,
            Identifier::from_str("receive_message")?,
            Identifier::from_str("stamp_receipt")?,
        )
        .with_type_args(vec![authenticator_type_tag]),
        vec![stamp_receipt_ticket, mt_state_arg],
    );

    tx.move_call(
        Function::new(
            message_transmitter_package,
            Identifier::from_str("receive_message")?,
            Identifier::from_str("complete_receive_message")?,
        ),
        vec![stamped_receipt, mt_state_arg],
    );

    tx.set_sender(sender);
    tx.set_gas_budget(50_000_000);

    // Resolve gas, simulate, and build the final transaction.
    let transaction = tx
        .build(&mut client)
        .await
        .map_err(|e| anyhow!("failed to build/simulate Sui transaction: {e}"))?;

    // Sign and execute.
    let digest = submit_signed_transaction(&mut client, transaction, &signing_key, &public_key)
        .await?;

    Ok(digest)
}

/// Fetch a shared object from the RPC node and build an `ObjectInput` with its current
/// initial-shared version.
async fn fetch_shared_object_input(
    client: &mut sui_rpc::Client,
    object_id: &str,
    mutable: bool,
) -> Result<ObjectInput> {
    let address =
        Address::from_str(object_id).map_err(|e| anyhow!("invalid object id {object_id}: {e}"))?;

    let response = client
        .ledger_client()
        .get_object(GetObjectRequest::new(&address))
        .await
        .map_err(|e| anyhow!("failed to fetch object {object_id}: {e}"))?
        .into_inner();

    let obj = response
        .object
        .ok_or_else(|| anyhow!("object {object_id} not found in response"))?;

    let owner = obj.owner.ok_or_else(|| anyhow!("object {object_id} has no owner"))?;
    let initial_shared_version = owner.version();

    Ok(ObjectInput::shared(address, initial_shared_version, mutable))
}

/// Sign a transaction with the provided Ed25519 key and submit it to the network,
/// waiting for checkpoint inclusion.
async fn submit_signed_transaction(
    client: &mut sui_rpc::Client,
    transaction: Transaction,
    signing_key: &ed25519_dalek::SigningKey,
    public_key: &Ed25519PublicKey,
) -> Result<String> {
    let signing_digest = transaction.signing_digest();
    let signature_bytes = signing_key.sign(&signing_digest).to_bytes();

    let user_signature = UserSignature::Simple(SimpleSignature::Ed25519 {
        signature: Ed25519Signature::new(signature_bytes),
        public_key: *public_key,
    });

    let proto_signature: ProtoUserSignature = user_signature.into();
    let request = ExecuteTransactionRequest::new(transaction.into())
        .with_signatures(vec![proto_signature]);

    let response = client
        .execute_transaction_and_wait_for_checkpoint(request, Duration::from_secs(60))
        .await
        .map_err(|e| anyhow!("transaction execution failed: {e}"))?;

    let executed = response
        .into_inner()
        .transaction
        .ok_or_else(|| anyhow!("missing transaction in execution response"))?;

    // Check execution status.
    let effects = executed
        .effects
        .as_ref()
        .ok_or_else(|| anyhow!("missing effects in execution response"))?;
    let status = effects.status();
    if !status.success() {
        let error = status
            .error
            .as_ref()
            .map(|e| format!("{:?}", e))
            .unwrap_or_else(|| "unknown execution error".to_string());
        return Err(anyhow!("Sui transaction failed: {error}"));
    }

    let digest = executed
        .digest
        .ok_or_else(|| anyhow!("missing transaction digest in response"))?;
    Ok(digest)
}
