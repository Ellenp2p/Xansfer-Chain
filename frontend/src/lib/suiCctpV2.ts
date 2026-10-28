/**
 * CCTP v2 programmable transaction builders for Sui.
 *
 * Circle's Sui CCTP v2 burn/mint are multi-step PTBs:
 *   burn:  deposit_for_burn -> handler::burn -> complete_burn
 *   mint:  receive_message -> prepare_mint -> handler::mint -> complete_mint
 *
 * Docs: https://developers.circle.com/cctp/references/sui-packages
 * Quickstart: https://developers.circle.com/cctp/quickstarts/transfer-usdc-sui-arc
 *
 * Pure module (no wallet/network access) so both the browser adapter and the
 * canary driver build exactly the same transactions.
 */

import { Transaction, type TransactionArgument } from '@mysten/sui/transactions'

/** Sui's shared deny-list object (same object ID on every network). */
export const SUI_DENY_LIST_OBJECT_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000403'

/** Sui's shared Clock object (0x6). */
export const SUI_CLOCK_OBJECT_ID = '0x6'

export interface SuiV2Deployment {
  tokenMessenger: string
  messageTransmitter: string
  stablecoinHandler: string
  tokenMessengerState: string
  messageTransmitterState: string
  stablecoinHandlerState: string
  treasury: string
}

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16))
  }
  return bytes
}

export interface SuiV2BurnParams {
  sender: string
  deployment: SuiV2Deployment
  usdcCoinType: string
  /** Amount in USDC base units (6 decimals). */
  amount: bigint
  destinationDomain: number
  /** 32-byte recipient, already normalised to 0x + 64 hex. */
  mintRecipient: string
  /**
   * USDC Coin object to split. `null` means the balance lives in the sender's
   * SIP-58 address balance, so the PTB redeems it with coin::redeem_funds.
   */
  coinObjectId: string | null
  maxFee?: bigint
  minFinalityThreshold?: number
}

export function buildSuiV2BurnTransaction(params: SuiV2BurnParams): Transaction {
  const {
    sender,
    deployment,
    usdcCoinType,
    amount,
    destinationDomain,
    mintRecipient,
    coinObjectId,
    maxFee = 0n,
    minFinalityThreshold = 2000,
  } = params

  const tx = new Transaction()
  tx.setSender(sender)

  let coinInput: TransactionArgument
  if (coinObjectId) {
    const [split] = tx.splitCoins(tx.object(coinObjectId), [tx.pure.u64(amount)])
    coinInput = split
  } else {
    const [redeemed] = tx.moveCall({
      target: '0x2::coin::redeem_funds',
      typeArguments: [usdcCoinType],
      arguments: [tx.withdrawal({ amount, type: usdcCoinType })],
    })
    coinInput = redeemed
  }

  const [burnReceipt, returnedCoin] = tx.moveCall({
    target: `${deployment.tokenMessenger}::deposit_for_burn::deposit_for_burn`,
    typeArguments: [usdcCoinType],
    arguments: [
      coinInput,
      tx.pure.u32(destinationDomain),
      tx.pure.address(mintRecipient),
      tx.pure.address('0x0'), // destinationCaller: permissionless
      tx.pure.u256(maxFee),
      tx.pure.u32(minFinalityThreshold),
      tx.pure.vector('u8', []), // hookData
      tx.object(deployment.tokenMessengerState),
    ],
  })

  const [completeBurnTicket] = tx.moveCall({
    target: `${deployment.stablecoinHandler}::handler::burn`,
    arguments: [
      tx.object(deployment.stablecoinHandlerState),
      burnReceipt,
      returnedCoin,
      tx.object(SUI_DENY_LIST_OBJECT_ID),
      tx.object(deployment.treasury),
    ],
  })

  tx.moveCall({
    target: `${deployment.tokenMessenger}::deposit_for_burn::complete_burn`,
    arguments: [
      completeBurnTicket,
      tx.object(deployment.tokenMessengerState),
      tx.object(deployment.messageTransmitterState),
    ],
    typeArguments: [usdcCoinType, `${deployment.stablecoinHandler}::handler::Auth`],
  })

  return tx
}

export interface SuiV2ClaimParams {
  sender: string
  deployment: SuiV2Deployment
  usdcCoinType: string
  message: string
  attestation: string
}

export function buildSuiV2ClaimTransaction(params: SuiV2ClaimParams): Transaction {
  const { sender, deployment, usdcCoinType, message, attestation } = params

  const tx = new Transaction()
  tx.setSender(sender)

  const [receipt] = tx.moveCall({
    target: `${deployment.messageTransmitter}::receive_message::receive_message`,
    arguments: [
      tx.pure.vector('u8', hexToBytes(message)),
      tx.pure.vector('u8', hexToBytes(attestation)),
      tx.object(deployment.messageTransmitterState),
    ],
  })

  const [mintReceipt] = tx.moveCall({
    target: `${deployment.tokenMessenger}::handle_receive_message::prepare_mint`,
    arguments: [
      receipt,
      tx.object(deployment.tokenMessengerState),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
    typeArguments: [usdcCoinType],
  })

  const [completeMintTicket] = tx.moveCall({
    target: `${deployment.stablecoinHandler}::handler::mint`,
    arguments: [
      tx.object(deployment.stablecoinHandlerState),
      mintReceipt,
      tx.object(deployment.tokenMessengerState),
      tx.object(deployment.treasury),
      tx.object(SUI_DENY_LIST_OBJECT_ID),
    ],
  })

  tx.moveCall({
    target: `${deployment.tokenMessenger}::handle_receive_message::complete_mint`,
    arguments: [
      completeMintTicket,
      tx.object(deployment.tokenMessengerState),
      tx.object(deployment.messageTransmitterState),
    ],
    typeArguments: [usdcCoinType, `${deployment.stablecoinHandler}::handler::Auth`],
  })

  return tx
}
