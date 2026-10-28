import { describe, expect, it } from 'vitest'
import {
  buildSuiV2BurnTransaction,
  buildSuiV2ClaimTransaction,
  SUI_DENY_LIST_OBJECT_ID,
  type SuiV2Deployment,
} from './suiCctpV2'

const hex32 = (byte: string) => `0x${byte.repeat(32)}`
const sender = hex32('bb')
const usdcCoinType = `${hex32('cc')}::usdc::USDC`

const deployment: SuiV2Deployment = {
  tokenMessenger: hex32('11'),
  messageTransmitter: hex32('22'),
  stablecoinHandler: hex32('33'),
  tokenMessengerState: hex32('44'),
  messageTransmitterState: hex32('55'),
  stablecoinHandlerState: hex32('66'),
  treasury: hex32('77'),
}

type MoveCall = {
  package: string
  module: string
  function: string
  typeArguments: string[]
}

function moveCalls(tx: ReturnType<typeof buildSuiV2BurnTransaction>): MoveCall[] {
  return tx.getData().commands
    .filter((command) => command.$kind === 'MoveCall')
    .map((command) => command.MoveCall as unknown as MoveCall)
}

function targets(calls: MoveCall[]): string[] {
  return calls.map((call) => `${call.package}::${call.module}::${call.function}`)
}

describe('Sui CCTP v2 burn PTB', () => {
  it('splits a Coin object, then burns and completes', () => {
    const tx = buildSuiV2BurnTransaction({
      sender,
      deployment,
      usdcCoinType,
      amount: 10_000n,
      destinationDomain: 6,
      mintRecipient: hex32('aa'),
      coinObjectId: hex32('dd'),
    })
    const data = tx.getData()
    expect(data.sender).toBe(sender)
    expect(data.commands[0].$kind).toBe('SplitCoins')
    expect(targets(moveCalls(tx))).toEqual([
      `${deployment.tokenMessenger}::deposit_for_burn::deposit_for_burn`,
      `${deployment.stablecoinHandler}::handler::burn`,
      `${deployment.tokenMessenger}::deposit_for_burn::complete_burn`,
    ])
    const complete = moveCalls(tx)[2]
    expect(complete.typeArguments).toEqual([usdcCoinType, `${deployment.stablecoinHandler}::handler::Auth`])
  })

  it('redeems a SIP-58 address balance when there is no Coin object', () => {
    const tx = buildSuiV2BurnTransaction({
      sender,
      deployment,
      usdcCoinType,
      amount: 10_000n,
      destinationDomain: 0,
      mintRecipient: hex32('aa'),
      coinObjectId: null,
    })
    expect(targets(moveCalls(tx))[0].endsWith('::coin::redeem_funds')).toBe(true)
    expect(targets(moveCalls(tx)).slice(1)).toEqual([
      `${deployment.tokenMessenger}::deposit_for_burn::deposit_for_burn`,
      `${deployment.stablecoinHandler}::handler::burn`,
      `${deployment.tokenMessenger}::deposit_for_burn::complete_burn`,
    ])
  })

  it('passes the deny-list object to handler::burn', () => {
    const tx = buildSuiV2BurnTransaction({
      sender,
      deployment,
      usdcCoinType,
      amount: 1n,
      destinationDomain: 0,
      mintRecipient: hex32('aa'),
      coinObjectId: hex32('dd'),
    })
    expect(JSON.stringify(tx.getData())).toContain(SUI_DENY_LIST_OBJECT_ID)
  })
})

describe('Sui CCTP v2 claim PTB', () => {
  it('receives, prepares, mints and completes', () => {
    const tx = buildSuiV2ClaimTransaction({
      sender,
      deployment,
      usdcCoinType,
      message: '0x0102',
      attestation: '0x0304',
    })
    expect(tx.getData().sender).toBe(sender)
    expect(targets(moveCalls(tx))).toEqual([
      `${deployment.messageTransmitter}::receive_message::receive_message`,
      `${deployment.tokenMessenger}::handle_receive_message::prepare_mint`,
      `${deployment.stablecoinHandler}::handler::mint`,
      `${deployment.tokenMessenger}::handle_receive_message::complete_mint`,
    ])
    const complete = moveCalls(tx)[3]
    expect(complete.typeArguments).toEqual([usdcCoinType, `${deployment.stablecoinHandler}::handler::Auth`])
  })
})
