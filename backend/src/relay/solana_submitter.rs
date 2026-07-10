use anyhow::{anyhow, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::str::FromStr;
use std::time::Duration;

const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// CCTP message header layout (see message_transmitter_v2::message::Message)
const MSG_SOURCE_DOMAIN_INDEX: usize = 4;
const MSG_DESTINATION_DOMAIN_INDEX: usize = 8;
const MSG_NONCE_INDEX: usize = 12;
const MSG_SENDER_INDEX: usize = 44;
const MSG_MESSAGE_BODY_INDEX: usize = 148;

// CCTP burn message body layout (see token_messenger_minter_v2::burn_message::BurnMessage)
const BURN_TOKEN_INDEX: usize = 4;
const BURN_MINT_RECIPIENT_INDEX: usize = 36;

/// Anchor account discriminator length.
const ANCHOR_DISCRIMINATOR_LEN: usize = 8;

/// Offset of `fee_recipient` inside the serialized `TokenMessenger` Anchor account.
/// Layout after discriminator: denylister(32), owner(32), pending_owner(32),
// message_body_version(4), authority_bump(1), fee_recipient(32), ...
const TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET: usize =
    ANCHOR_DISCRIMINATOR_LEN + 32 + 32 + 32 + 4 + 1;

/// Submit a CCTP receiveMessage on Solana.
///
/// Constructs the MessageTransmitterV2 `receive_message` instruction with the
/// full set of remaining accounts required by TokenMessengerMinterV2's
/// `handle_receive_finalized_message` CPI.
#[allow(clippy::too_many_arguments)]
pub async fn submit_receive_message(
    rpc_url: &str,
    message_transmitter: &str,
    token_messenger_minter: &str,
    usdc_mint: &str,
    keypair_bs58: &str,
    message_hex: &str,
    attestation_hex: &str,
    _recipient_token_account: &str,
    _source_domain: i64,
) -> Result<String> {
    let message = decode_hex(message_hex)?;
    let attestation = decode_hex(attestation_hex)?;

    if message.len() < MSG_MESSAGE_BODY_INDEX {
        return Err(anyhow!("CCTP message too short"));
    }
    let message_body = &message[MSG_MESSAGE_BODY_INDEX..];
    if message_body.len() < BURN_MINT_RECIPIENT_INDEX + 32 {
        return Err(anyhow!("CCTP message body too short"));
    }

    let source_domain = read_u32_be(&message[MSG_SOURCE_DOMAIN_INDEX..MSG_DESTINATION_DOMAIN_INDEX]);
    let nonce = &message[MSG_NONCE_INDEX..MSG_SENDER_INDEX];
    let burn_token = &message_body[BURN_TOKEN_INDEX..BURN_MINT_RECIPIENT_INDEX];
    let mint_recipient = &message_body[BURN_MINT_RECIPIENT_INDEX..BURN_MINT_RECIPIENT_INDEX + 32];

    let payer = keypair_from_bs58(keypair_bs58)?;
    let payer_pubkey = payer.pubkey();

    let mt_program = Pubkey::from_str(message_transmitter)
        .map_err(|e| anyhow!("invalid message_transmitter program id: {e}"))?;
    let tmm_program = Pubkey::from_str(token_messenger_minter)
        .map_err(|e| anyhow!("invalid token_messenger_minter program id: {e}"))?;
    let usdc_mint_pubkey = Pubkey::from_str(usdc_mint)
        .map_err(|e| anyhow!("invalid usdc_mint: {e}"))?;
    let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID)?;
    let associated_token_program = Pubkey::from_str(ASSOCIATED_TOKEN_PROGRAM_ID)?;

    // Derive all PDAs.
    let message_transmitter_state =
        derive_pda(&[b"message_transmitter"], &mt_program);
    let authority_pda = derive_pda(
        &[b"message_transmitter_authority", tmm_program.as_ref()],
        &mt_program,
    );
    let used_nonce = derive_pda(&[b"used_nonce", nonce], &mt_program);

    let token_messenger = derive_pda(&[b"token_messenger"], &tmm_program);
    let remote_token_messenger = derive_pda(
        &[b"remote_token_messenger", &source_domain.to_be_bytes()],
        &tmm_program,
    );
    let token_minter = derive_pda(&[b"token_minter"], &tmm_program);
    let local_token = derive_pda(
        &[b"local_token", usdc_mint_pubkey.as_ref()],
        &tmm_program,
    );
    let token_pair = derive_pda(
        &[
            b"token_pair",
            source_domain.to_string().as_bytes(),
            burn_token,
        ],
        &tmm_program,
    );
    let custody_token_account = derive_pda(
        &[b"custody", usdc_mint_pubkey.as_ref()],
        &tmm_program,
    );
    let event_authority = derive_pda(&[b"__event_authority"], &tmm_program);

    // Recipient token account comes from the burn message itself; this is the
    // account the source-chain burn designated as the mint recipient.
    let recipient_token_account =
        Pubkey::try_from(mint_recipient).map_err(|_| anyhow!("invalid mint_recipient in message"))?;

    // Fetch fee_recipient from the on-chain TokenMessenger account and derive
    // its associated token account for the local USDC mint.
    let rpc = RpcClient::new(rpc_url.to_string());
    let fee_recipient = fetch_token_messenger_fee_recipient(&rpc, &token_messenger).await?;
    let fee_recipient_token_account = Pubkey::find_program_address(
        &[
            fee_recipient.as_ref(),
            token_program.as_ref(),
            usdc_mint_pubkey.as_ref(),
        ],
        &associated_token_program,
    )
    .0;

    // Anchor discriminator for `receive_message`.
    let mut data = Vec::with_capacity(8 + 8 + message.len() + attestation.len());
    data.extend_from_slice(&anchor_discriminator("global:receive_message"));
    // Borsh-serialize ReceiveMessageParams { message: Vec<u8>, attestation: Vec<u8> }
    data.extend_from_slice(&(message.len() as u32).to_le_bytes());
    data.extend_from_slice(&message);
    data.extend_from_slice(&(attestation.len() as u32).to_le_bytes());
    data.extend_from_slice(&attestation);

    let accounts = vec![
        // MessageTransmitter receive_message context
        AccountMeta::new(payer_pubkey, true),        // payer
        AccountMeta::new_readonly(payer_pubkey, true), // caller
        AccountMeta::new_readonly(authority_pda, false), // authority_pda
        AccountMeta::new_readonly(message_transmitter_state, false), // message_transmitter
        AccountMeta::new(used_nonce, false),         // used_nonce
        AccountMeta::new_readonly(tmm_program, false), // receiver
        AccountMeta::new_readonly(solana_sdk::system_program::id(), false), // system_program
        // Remaining accounts passed to TokenMessengerMinter handle_receive_message CPI
        AccountMeta::new_readonly(authority_pda, true), // authority_pda (CPI signer)
        AccountMeta::new_readonly(token_messenger, false),
        AccountMeta::new_readonly(remote_token_messenger, false),
        AccountMeta::new(token_minter, false),
        AccountMeta::new(local_token, false),
        AccountMeta::new_readonly(token_pair, false),
        AccountMeta::new(fee_recipient_token_account, false),
        AccountMeta::new(recipient_token_account, false),
        AccountMeta::new(custody_token_account, false),
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(tmm_program, false),
    ];

    let receive_ix = Instruction {
        program_id: mt_program,
        accounts,
        data,
    };

    // CCTP on Solana needs more than the default compute budget.
    let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(400_000);

    let latest_blockhash = rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| anyhow!("failed to get latest blockhash: {e}"))?;

    let tx = Transaction::new_signed_with_payer(
        &[budget_ix, receive_ix],
        Some(&payer_pubkey),
        &[&payer],
        latest_blockhash,
    );

    let signature = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(|e| anyhow!("Solana transaction failed: {e}"))?;

    Ok(signature.to_string())
}

fn decode_hex(s: &str) -> Result<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).map_err(|e| anyhow!("hex decode error: {e}"))
}

fn read_u32_be(bytes: &[u8]) -> u32 {
    let mut arr = [0u8; 4];
    arr.copy_from_slice(bytes);
    u32::from_be_bytes(arr)
}

fn keypair_from_bs58(s: &str) -> Result<Keypair> {
    let decoded = bs58::decode(s)
        .into_vec()
        .map_err(|e| anyhow!("invalid base58 keypair: {e}"))?;
    if decoded.len() == 64 {
        Keypair::try_from(decoded.as_slice()).map_err(|e| anyhow!("invalid keypair bytes: {e}"))
    } else if decoded.len() == 32 {
        let secret: [u8; 32] = decoded.try_into().map_err(|_| anyhow!("invalid secret key length"))?;
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&secret);
        let public = signing_key.verifying_key();
        let mut bytes = [0u8; 64];
        bytes[..32].copy_from_slice(&secret);
        bytes[32..].copy_from_slice(public.as_bytes());
        Keypair::try_from(bytes.as_slice()).map_err(|e| anyhow!("invalid derived keypair: {e}"))
    } else {
        Err(anyhow!(
            "Solana key must be 32 (secret) or 64 (keypair) bytes, got {}",
            decoded.len()
        ))
    }
}

fn derive_pda(seeds: &[&[u8]], program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program_id).0
}

fn anchor_discriminator(sig: &str) -> [u8; 8] {
    let hash = solana_sdk::hash::hash(sig.as_bytes()).to_bytes();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

async fn fetch_token_messenger_fee_recipient(
    rpc: &RpcClient,
    token_messenger: &Pubkey,
) -> Result<Pubkey> {
    let account = tokio::time::timeout(Duration::from_secs(30), rpc.get_account(token_messenger))
        .await
        .map_err(|_| anyhow!("timeout fetching token_messenger account"))?
        .map_err(|e| anyhow!("failed to fetch token_messenger account: {e}"))?;

    let data = account.data;
    let end = TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 32;
    if data.len() < end {
        return Err(anyhow!(
            "token_messenger account data too short: {} bytes",
            data.len()
        ));
    }
    let bytes = &data[TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET..end];
    Pubkey::try_from(bytes).map_err(|_| anyhow!("invalid fee_recipient pubkey in account data"))
}
