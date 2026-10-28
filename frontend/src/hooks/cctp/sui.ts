import { useCallback } from 'react'
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClientContext } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useNetworkMode } from '../../stores/networkMode'
import { getCctpContracts, getChainByDomain, type CctpContractSet } from '../../config/chains'
import { assertDestinationAddress } from '../../lib/address'
import { normalizeMintRecipient } from '../../lib/cctpEncoding'
import { parseUsdcUnits } from '../../lib/fees'
import {
  buildSuiV2BurnTransaction,
  buildSuiV2ClaimTransaction,
  type SuiV2Deployment,
} from '../../lib/suiCctpV2'
import type { ChainAdapter, SourceBurnParams, ClaimParams } from './types'
import type { ChainConfig, ChainType } from '../../types'

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

interface SuiCctpV1Objects {
  tokenMessengerMinterState: string
  messageTransmitterState: string
  treasury: string
}

interface SuiCctpV2Objects {
  tokenMessengerMinterState: string
  messageTransmitterState: string
  stablecoinHandlerState: string
  stablecoinHandlerPackage: string
  treasury: string
}

const CCTP_V1_OBJECTS: Record<string, SuiCctpV1Objects> = {
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

// Circle CCTP v2 on Sui: https://developers.circle.com/cctp/references/sui-packages
const CCTP_V2_OBJECTS: Record<string, SuiCctpV2Objects> = {
  mainnet: {
    tokenMessengerMinterState: '0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167',
    messageTransmitterState: '0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c',
    stablecoinHandlerState: '0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41',
    stablecoinHandlerPackage: '0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf',
    treasury: '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
  },
  testnet: {
    tokenMessengerMinterState: '0x72cb55cd14d01e6361386d6ea93eecda9fa1efc3c202b8dd69c1e4683e4c0ca0',
    messageTransmitterState: '0xfee3a2b47f9ef2de2405fc63d79194307945f8ea768815cfc46083bc20fbe6ed',
    stablecoinHandlerState: '0xfbd9c0517c4f0e1817445ee2be598806e3c392a465d7e3d773d1055f3f0eed32',
    stablecoinHandlerPackage: '0xbe8479044396a45e07de2c7f14789c35b8338406eebc53b2527da56839a91561',
    treasury: '0x7170137d4a6431bf83351ac025baf462909bffe2877d87716374fb42b9629ebe',
  },
}

function usdcCoinType(usdcPackage: string): string {
  return `${usdcPackage}::usdc::USDC`
}

function deploymentFor(mode: string, contracts: CctpContractSet): SuiV2Deployment | null {
  const objects = CCTP_V2_OBJECTS[mode]
  const stablecoinHandler = contracts.stablecoinHandler ?? objects?.stablecoinHandlerPackage
  if (!objects || !stablecoinHandler) return null
  return {
    tokenMessenger: contracts.tokenMessenger,
    messageTransmitter: contracts.messageTransmitter,
    stablecoinHandler,
    tokenMessengerState: objects.tokenMessengerMinterState,
    messageTransmitterState: objects.messageTransmitterState,
    stablecoinHandlerState: objects.stablecoinHandlerState,
    treasury: objects.treasury,
  }
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
    pageInfo: {
      hasNextPage: boolean
      endCursor: string | null
    }
  }
}

const FIND_USDC_COIN_QUERY = `
  query FindUsdcCoin($owner: SuiAddress!, $type: String!, $after: String) {
    objects(filter: {owner: $owner, type: $type}, first: 50, after: $after) {
      nodes { address asMoveObject { contents { json } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`

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
  let after: string | null = null
  for (;;) {
    const data: FindUsdcCoinResponse = await graphqlQuery<FindUsdcCoinResponse>(
      mode,
      FIND_USDC_COIN_QUERY,
      { owner, type, after },
    )
    const coins = data.objects.nodes
      .map((n) => ({ objectId: n.address, balance: n.asMoveObject.contents.json.balance }))
      .sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)))
    const coin = coins.find((c) => BigInt(c.balance) >= requiredAmount)
    if (coin) return coin
    if (!data.objects.pageInfo.hasNextPage) break
    after = data.objects.pageInfo.endCursor
  }
  throw new Error('Insufficient USDC balance or no USDC coin object found')
}

async function tryFindUsdcCoin(
  mode: string,
  owner: string,
  coinType: string,
  requiredAmount: bigint,
): Promise<SuiCoin | null> {
  try {
    return await findUsdcCoin(mode, owner, coinType, requiredAmount)
  } catch (error) {
    // No spendable Coin object: the balance may live in a SIP-58 address
    // balance instead, which the v2 burn redeems with coin::redeem_funds.
    if ((error as Error).message.includes('Insufficient USDC balance')) return null
    throw error
  }
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

async function executeTransactionViaGraphQL(
  mode: string,
  { bytes, signature }: { bytes: string; signature: string },
): Promise<{ digest: string }> {
  const endpoint = GRAPHQL_ENDPOINTS[mode]
  if (!endpoint) throw new Error(`No Sui GraphQL endpoint for mode "${mode}"`)
  const query = `
    mutation ExecuteTx($tx: Base64!, $sigs: [String!]!) {
      executeTransaction(transactionDataBcs: $tx, signatures: $sigs) {
        effects { digest status }
      }
    }
  `
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { tx: bytes, sigs: [signature] } }),
  })
  if (!resp.ok) throw new Error(`Sui GraphQL execute failed: ${resp.status}`)
  const json = await resp.json()
  if (json.errors) throw new Error(`Sui GraphQL execute errors: ${JSON.stringify(json.errors)}`)
  const digest = json.data?.executeTransaction?.effects?.digest
  if (!digest) throw new Error('Sui GraphQL execute did not return a digest')
  return { digest }
}

function useGraphqlSignAndExecute(mode: string) {
  const execute = useCallback(
    async (input: { bytes: string; signature: string }) => executeTransactionViaGraphQL(mode, input),
    [mode],
  )
  return useSignAndExecuteTransaction({ execute })
}

export function useSuiAdapter(): ChainAdapter {
  const account = useCurrentAccount()
  const mode = useNetworkMode((s) => s.mode)
  const { network: suiNetwork } = useSuiClientContext()
  const { mutateAsync: signAndExecute } = useGraphqlSignAndExecute(mode)

  const assertWalletNetwork = useCallback(() => {
    if (suiNetwork !== mode) {
      throw new Error(`Sui wallet is on "${suiNetwork}" but the app is in ${mode} mode — switch the wallet network and retry`)
    }
  }, [suiNetwork, mode])

  const switchChain = useCallback(async (_domain: number) => {
    // Sui has a single network per provider — no EVM-style chain switching.
  }, [])

  const approveUsdc = useCallback(async (_chainConfig: ChainConfig, _amount: string, _cctpVersion?: number) => {
    // Sui CCTP deposit_for_burn takes a Coin directly; no separate approve step.
  }, [])

  const burnUsdc = useCallback(
    async ({ chainConfig, amount, destDomain, destAddress, cctpVersion = 1, destChainType }: SourceBurnParams): Promise<string> => {
      if (!account?.address) throw new Error('Sui wallet not connected')
      if (cctpVersion !== 1 && cctpVersion !== 2) throw new Error(`Unsupported Sui CCTP version: v${cctpVersion}`)
      if (destChainType === 'stellar') throw new Error('Sui -> Stellar forwarding is not supported')
      assertWalletNetwork()
      assertDestinationAddress(destAddress, destChainType as ChainType, mode)

      const contracts = getCctpContracts(chainConfig.domain, cctpVersion, mode)
      if (!contracts) throw new Error(`No CCTP v${cctpVersion} contracts configured for Sui domain ${chainConfig.domain}`)

      const amountRaw = parseUsdcUnits(amount, chainConfig.usdc_decimals ?? 6)
      const usdcType = usdcCoinType(chainConfig.usdc_address.split('::')[0])

      let tx: Transaction
      if (cctpVersion === 2) {
        // CCTP v2 on Sui: deposit_for_burn -> handler::burn -> complete_burn.
        const deployment = deploymentFor(mode, contracts)
        if (!deployment) throw new Error(`No known CCTP v2 shared objects for Sui mode "${mode}"`)

        // USDC can live in Coin objects (v1 mints) or a SIP-58 address balance
        // (Circle faucet / v2 mint). Support both.
        const coin = await tryFindUsdcCoin(mode, account.address, usdcType, amountRaw)
        tx = buildSuiV2BurnTransaction({
          sender: account.address,
          deployment,
          usdcCoinType: usdcType,
          amount: amountRaw,
          destinationDomain: destDomain,
          mintRecipient: normalizeMintRecipient(destAddress),
          coinObjectId: coin?.objectId ?? null,
        })
      } else {
        // CCTP v1: single deposit_for_burn call (legacy paths only).
        const objects = CCTP_V1_OBJECTS[mode]
        if (!objects) throw new Error(`No known CCTP v1 shared objects for Sui mode "${mode}"`)
        const coin = await findUsdcCoin(mode, account.address, usdcType, amountRaw)

        tx = new Transaction()
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
      }

      const result = await signAndExecute({ transaction: tx, chain: `sui:${mode}` })
      return result.digest
    },
    [account, mode, signAndExecute, assertWalletNetwork],
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
      if (cctpVersion !== 1 && cctpVersion !== 2) throw new Error(`Unsupported Sui CCTP version: v${cctpVersion}`)
      assertWalletNetwork()

      const chainConfig = getChainByDomain(destDomain, mode)
      if (!chainConfig || chainConfig.chain_type !== 'sui') throw new Error('Destination chain is not Sui')

      const contracts = getCctpContracts(destDomain, cctpVersion, mode)
      if (!contracts) throw new Error(`No CCTP v${cctpVersion} contracts configured for Sui domain ${destDomain}`)

      const usdcType = usdcCoinType(chainConfig.usdc_address.split('::')[0])
      const messageBytes = hexToBytes(message)
      const attestationBytes = hexToBytes(attestation)

      let tx: Transaction
      if (cctpVersion === 2) {
        // CCTP v2 on Sui: receive_message -> prepare_mint -> handler::mint -> complete_mint.
        // The minted Coin<USDC> is public_transfer'd to the signer; a later v2 burn
        // picks it up as a Coin object (or the user can fold it with coin::send_funds).
        const deployment = deploymentFor(mode, contracts)
        if (!deployment) throw new Error(`No known CCTP v2 shared objects for Sui mode "${mode}"`)
        tx = buildSuiV2ClaimTransaction({
          sender: account.address,
          deployment,
          usdcCoinType: usdcType,
          message,
          attestation,
        })
      } else {
        // CCTP v1 legacy claim path.
        const objects = CCTP_V1_OBJECTS[mode]
        if (!objects) throw new Error(`No known CCTP v1 shared objects for Sui mode "${mode}"`)

        tx = new Transaction()
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

        const [stampTicket] = tx.moveCall({
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
      }

      const result = await signAndExecute({ transaction: tx, chain: `sui:${mode}` })
      return result.digest
    },
    [account, mode, signAndExecute, assertWalletNetwork],
  )

  return {
    switchChain,
    approveUsdc,
    burnUsdc,
    waitForSourceTx,
    claimOnDest,
  }
}
