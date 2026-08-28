import { useCallback } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useNetworkMode } from '../../stores/networkMode'
import { getCctpContracts, getChainByDomain } from '../../config/chains'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig } from '../../types'

const GRAPHQL_ENDPOINTS: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
}

const DENY_LIST_OBJECT_ID = '0x0000000000000000000000000000000000000000000000000000000000000403'

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16))
  }
  return bytes
}

interface SuiCctpObjects {
  tokenMessengerMinterState: string
  messageTransmitterState: string
  treasury: string
}

const CCTP_OBJECTS: Record<string, SuiCctpObjects> = {
  mainnet: {
    tokenMessengerMinterState: '0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f',
    messageTransmitterState: '0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af',
    treasury: '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
  },
  testnet: {
    tokenMessengerMinterState: '0x5252abd1137094ed1db3e0d75bc36abcd287aee4bc310f8e047727ef5682e7c2',
    messageTransmitterState: '0x98234bd0fa9ac12cc0a20a144a22e36d6a32f7e0a97baaeaf9c76cdc6d122d2e',
    treasury: '0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe',
  },
}

/**
 * CCTP mint_recipient for a non-Move destination must be a 32-byte address.
 * EVM addresses are left-padded to 32 bytes; Sui addresses are already 32 bytes.
 */
function normalizeMintRecipient(addr: string): string {
  const clean = addr.replace(/^0x/i, '')
  if (clean.length === 64) return `0x${clean}`
  return `0x${clean.padStart(64, '0')}`
}

function usdcCoinType(usdcPackage: string): string {
  return `${usdcPackage}::usdc::USDC`
}

async function graphqlQuery<T = any>(mode: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const endpoint = GRAPHQL_ENDPOINTS[mode]
  if (!endpoint) throw new Error(`No Sui GraphQL endpoint for mode "${mode}"`)
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!resp.ok) throw new Error(`Sui GraphQL query failed: ${resp.status}`)
  const json = await resp.json()
  if (json.errors) throw new Error(`Sui GraphQL errors: ${JSON.stringify(json.errors)}`)
  return json.data
}

interface SuiCoin {
  objectId: string
  balance: string
}

interface FindUsdcCoinResponse {
  objects: {
    nodes: {
      address: string
      asMoveObject: {
        contents: {
          json: {
            balance: string
          }
        }
      }
    }[]
  }
}

interface WaitForTxResponse {
  transactionEffects: {
    status: string
    transaction: {
      transactionJson: {
        sender: string
      }
    }
  } | null
}

async function findUsdcCoin(
  mode: string,
  owner: string,
  coinType: string,
  requiredAmount: bigint,
): Promise<SuiCoin> {
  const type = `0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<${coinType}>`
  const data = await graphqlQuery<FindUsdcCoinResponse>(
    mode,
    `{ objects(filter: {owner: "${owner}", type: "${type}"}, first: 50) { nodes { address asMoveObject { contents { json } } } } } }`,
  )
  const coins = data.objects.nodes
    .map((n) => ({ objectId: n.address, balance: n.asMoveObject.contents.json.balance }))
    .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))
  const coin = coins.find((c) => BigInt(c.balance) >= requiredAmount)
  if (!coin) throw new Error('Insufficient USDC balance or no USDC coin object found')
  return coin
}

async function waitForTransaction(mode: string, digest: string): Promise<{ sender: string }> {
  for (let i = 0; i < 60; i++) {
    try {
      const data = await graphqlQuery<WaitForTxResponse>(
        mode,
        `{ transactionEffects(digest: "${digest}") { status transaction { transactionJson } } }`,
      )
      if (data.transactionEffects?.status === 'SUCCESS') {
        return { sender: data.transactionEffects.transaction.transactionJson.sender }
      }
    } catch {
      // not found yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Sui transaction ${digest} did not confirm in time`)
}

export function useSuiAdapter(): ChainAdapter {
  const account = useCurrentAccount()
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction()
  const mode = useNetworkMode((s) => s.mode)

  const switchChain = useCallback(async (_domain: number) => {
    // Sui has a single network per provider — no EVM-style chain switching.
  }, [])

  const approveUsdc = useCallback(async (_chainConfig: ChainConfig, _amount: string, _cctpVersion?: number) => {
    // Sui CCTP deposit_for_burn takes a Coin directly; no separate approve step.
  }, [])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, cctpVersion = 1, destChainType }: SourceBurnParams): Promise<string> => {
      if (!account?.address) throw new Error('Sui wallet not connected')
      if (cctpVersion !== 1) throw new Error('Sui CCTP only supports v1')
      if (destChainType === 'stellar') throw new Error('Sui -> Stellar forwarding is not supported')

      const contracts = getCctpContracts(chainConfig.domain, cctpVersion, mode)
      if (!contracts) throw new Error(`No CCTP v1 contracts configured for Sui domain ${chainConfig.domain}`)
      const objects = CCTP_OBJECTS[mode]
      if (!objects) throw new Error(`No known CCTP shared objects for Sui mode "${mode}"`)

      const amountRaw = BigInt(Math.floor(parseFloat(amount) * 1_000_000))
      const usdcType = usdcCoinType(chainConfig.usdc_address.split('::')[0])
      const coin = await findUsdcCoin(mode, account.address, usdcType, amountRaw)

      const tx = new Transaction()
      tx.setSender(account.address)

      const [splitCoin] = tx.splitCoins(tx.object(coin.objectId), [tx.pure.u64(amountRaw)])

      tx.moveCall({
        target: `${contracts.tokenMessenger}::deposit_for_burn::deposit_for_burn`,
        typeArguments: [usdcType],
        arguments: [
          splitCoin,
          tx.pure.u32(destDomain),
          tx.pure.address(normalizeMintRecipient(destAddress)),
          tx.object(objects.tokenMessengerMinterState),
          tx.object(objects.messageTransmitterState),
          tx.object(DENY_LIST_OBJECT_ID),
          tx.object(objects.treasury),
        ],
      })

      const result = await signAndExecute({ transaction: tx })
      return result.digest
    },
    [account, mode, signAndExecute],
  )

  const waitForSourceTx = useCallback(
    async (txHash: string, _chainConfig: ChainConfig) => {
      await waitForTransaction(mode, txHash)
      return { transactionHash: txHash }
    },
    [mode],
  )

  const claimOnDest = useCallback(
    async ({ message, attestation, destDomain, cctpVersion }: ClaimParams): Promise<string> => {
      if (!account?.address) throw new Error('Sui wallet not connected')
      if (cctpVersion !== 1) throw new Error('Sui CCTP only supports v1')

      const chainConfig = getChainByDomain(destDomain, mode)
      if (!chainConfig || chainConfig.chain_type !== 'sui') throw new Error('Destination chain is not Sui')

      const contracts = getCctpContracts(destDomain, cctpVersion, mode)
      if (!contracts) throw new Error(`No CCTP v1 contracts configured for Sui domain ${destDomain}`)
      const objects = CCTP_OBJECTS[mode]
      if (!objects) throw new Error(`No known CCTP shared objects for Sui mode "${mode}"`)

      const usdcType = usdcCoinType(chainConfig.usdc_address.split('::')[0])

      const messageBytes = hexToBytes(message)
      const attestationBytes = hexToBytes(attestation)

      const tx = new Transaction()
      tx.setSender(account.address)

      const receipt = tx.moveCall({
        target: `${contracts.messageTransmitter}::receive_message::receive_message`,
        arguments: [
          tx.pure.vector('u8', messageBytes),
          tx.pure.vector('u8', attestationBytes),
          tx.object(objects.messageTransmitterState),
        ],
      })

      const stampReceiptTicketWithBurnMessage = tx.moveCall({
        target: `${contracts.tokenMessenger}::handle_receive_message::handle_receive_message`,
        typeArguments: [usdcType],
        arguments: [
          receipt,
          tx.object(objects.tokenMessengerMinterState),
          tx.object(DENY_LIST_OBJECT_ID),
          tx.object(objects.treasury),
        ],
      })

      const [stampTicket, _burnMessage] = tx.moveCall({
        target: `${contracts.tokenMessenger}::handle_receive_message::deconstruct_stamp_receipt_ticket_with_burn_message`,
        arguments: [stampReceiptTicketWithBurnMessage],
      })

      const authenticatorType = `${contracts.tokenMessenger}::message_transmitter_authenticator::MessageTransmitterAuthenticator`
      const stampedReceipt = tx.moveCall({
        target: `${contracts.messageTransmitter}::receive_message::stamp_receipt`,
        typeArguments: [authenticatorType],
        arguments: [stampTicket, tx.object(objects.messageTransmitterState)],
      })

      tx.moveCall({
        target: `${contracts.messageTransmitter}::receive_message::complete_receive_message`,
        arguments: [stampedReceipt, tx.object(objects.messageTransmitterState)],
      })

      const result = await signAndExecute({ transaction: tx })
      return result.digest
    },
    [account, mode, signAndExecute],
  )

  return {
    switchChain,
    approveUsdc,
    burnUsdc,
    waitForSourceTx,
    claimOnDest,
  }
}
