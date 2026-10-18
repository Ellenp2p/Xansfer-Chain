/** Starknet canary driver: CCTP v2 (Starknet Sepolia). */

import { Account, CairoByteArray, CallData, Contract, RpcProvider, addAddressPadding } from 'starknet'
import { normalizeMintRecipient } from '../../src/lib/cctpEncoding'
import { fetchCircleMaxFee } from '../../src/lib/fees'
import { addressOverride, contractsFor } from './core'
import { STELLAR_CCTP_FORWARDER, buildHookDataForStellar } from './dest'
import type { BurnRequest, CanaryDriver, ClaimRequest, DriverChain, DriverContext } from './types'

const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
const ZERO_U256 = '0x0'

function provider(chain: DriverChain): RpcProvider {
  return new RpcProvider({ nodeUrl: chain.rpc_url })
}

function account(chain: DriverChain, secret: string): Account {
  const address = addressOverride('starknet')
  if (!address) {
    throw new Error('Starknet canary requires CANARY_STARKNET_ADDRESS (the account address cannot be derived from the key)')
  }
  return new Account({ provider: provider(chain), address: addAddressPadding(address), signer: secret })
}

function isSuccess(receipt: unknown): boolean {
  const value = receipt as { isSuccess?: () => boolean; execution_status?: string }
  if (typeof value.isSuccess === 'function') return value.isSuccess()
  return value.execution_status === 'SUCCEEDED'
}

async function wait(chain: DriverChain, hash: string): Promise<void> {
  const receipt = await provider(chain).waitForTransaction(hash)
  if (!isSuccess(receipt)) throw new Error(`Starknet transaction failed: ${hash}`)
}

async function contractAt(chain: DriverChain, address: string, signer: Account | RpcProvider): Promise<Contract> {
  const { abi } = await provider(chain).getClassAt(address)
  return new Contract({ abi: abi as never, address, providerOrAccount: signer })
}

async function erc20Balance(chain: DriverChain, token: string, owner: string): Promise<bigint> {
  const result = await provider(chain).callContract({
    contractAddress: token,
    entrypoint: 'balanceOf',
    calldata: [addAddressPadding(owner)],
  })
  const [low = '0x0', high = '0x0'] = result as string[]
  return BigInt(low) + (BigInt(high) << 128n)
}

function toU256(hexOrAddress: string): bigint {
  return BigInt(normalizeMintRecipient(hexOrAddress))
}

export const starknetDriver: CanaryDriver = {
  type: 'starknet',
  nativeSymbol: 'STRK',
  nativeDecimals: 18,
  defaultMinNative: 0n, // native gas is paid in STRK; preflight is best-effort

  address() {
    const address = addressOverride('starknet')
    if (!address) throw new Error('Starknet canary requires CANARY_STARKNET_ADDRESS')
    return addAddressPadding(address)
  },

  async nativeBalance(chain, address) {
    return await erc20Balance(chain, STRK_TOKEN, address)
  },

  async usdcBalance(chain, address) {
    return await erc20Balance(chain, chain.usdc_address, address)
  },

  async burn(ctx: DriverContext, req: BurnRequest): Promise<string> {
    const { chain, version, amountUnits, destDomain, destChain, destAddress, fast, secret } = req
    if (version !== 2) throw new Error('Starknet testnet only supports CCTP v2')
    const { tokenMessenger } = contractsFor(ctx, version, chain.domain)
    const signer = account(chain, secret)

    const finalityThreshold = fast ? 1000 : 2000
    const maxFee = await fetchCircleMaxFee({
      mode: 'testnet',
      srcDomain: chain.domain,
      destDomain,
      finalityThreshold,
      amountUnits,
    })

    const usdc = await contractAt(chain, chain.usdc_address, signer)
    ctx.log(`${chain.name}: approving ${amountUnits} USDC to ${tokenMessenger}`)
    const approveTx = await usdc.invoke('approve', [tokenMessenger, amountUnits])
    await wait(chain, approveTx.transaction_hash)

    const messenger = await contractAt(chain, tokenMessenger, signer)
    const stellarAccount = destChain.chain_type === 'stellar' && destAddress.startsWith('G')
    const mintRecipient = stellarAccount
      ? toU256(STELLAR_CCTP_FORWARDER.testnet)
      : toU256(destAddress)

    const baseArgs = [
      amountUnits,
      destDomain,
      mintRecipient,
      addAddressPadding(chain.usdc_address),
      ZERO_U256,
      maxFee,
      finalityThreshold,
    ]

    ctx.log(`${chain.name}: burning ${amountUnits} USDC units -> domain ${destDomain}`)
    const tx = stellarAccount
      ? await messenger.invoke('deposit_for_burn_with_hook', [
          ...baseArgs,
          new CairoByteArray(buildHookDataForStellar(destAddress)),
        ])
      : await messenger.invoke('deposit_for_burn', baseArgs)
    await wait(chain, tx.transaction_hash)
    return tx.transaction_hash
  },

  async claim(ctx: DriverContext, req: ClaimRequest): Promise<string> {
    const { chain, version, message, attestation, secret } = req
    if (version !== 2) throw new Error('Starknet testnet only supports CCTP v2')
    const { messageTransmitter } = contractsFor(ctx, version, chain.domain)
    const signer = account(chain, secret)

    const messageBytes = new CairoByteArray(Buffer.from(message.replace(/^0x/, ''), 'hex'))
    const attestationBytes = new CairoByteArray(Buffer.from(attestation.replace(/^0x/, ''), 'hex'))
    const calldata = CallData.compile([
      ...messageBytes.toApiRequest(),
      ...attestationBytes.toApiRequest(),
    ])

    ctx.log(`${chain.name}: claiming via MessageTransmitter ${messageTransmitter}`)
    const tx = await signer.execute({
      contractAddress: messageTransmitter,
      entrypoint: 'receive_message',
      calldata,
    })
    await wait(chain, tx.transaction_hash)
    return tx.transaction_hash
  },
}
