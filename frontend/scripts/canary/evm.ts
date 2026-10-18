/** EVM canary driver: CCTP v1/v2 burn + receiveMessage. */

import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Address, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { MESSAGE_TRANSMITTER_V1_ABI, MESSAGE_TRANSMITTER_V2_ABI, TOKEN_MESSENGER_V1_ABI, TOKEN_MESSENGER_V2_ABI } from '../../src/config/cctp-abi'
import { buildCctpForwarderHookData } from '../../src/lib/cctpEncoding'
import { fetchCircleMaxFee } from '../../src/lib/fees'
import { contractsFor } from './core'
import { STELLAR_CCTP_FORWARDER, bytes32, isStellarAccount, solanaUsdcAtaHex } from './dest'
import type { BurnRequest, CanaryDriver, ClaimRequest, DriverChain, DriverContext } from './types'

const ERC20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex

function toViemChain(chain: DriverChain): Chain {
  if (chain.chain_id == null) throw new Error(`${chain.name} has no chain_id`)
  return {
    id: chain.chain_id,
    name: chain.name,
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [chain.rpc_url] } },
  } as Chain
}

function publicClient(chain: DriverChain) {
  return createPublicClient({ chain: toViemChain(chain), transport: http(chain.rpc_url) })
}

function walletClient(chain: DriverChain, secret: string) {
  return createWalletClient({
    account: privateKeyToAccount(secret as Hex),
    chain: toViemChain(chain),
    transport: http(chain.rpc_url),
  })
}

/** Legacy ABI name compatibility: the shape is identical, only the arg count differs. */
function abiFor(version: number) {
  return version === 1
    ? { burn: TOKEN_MESSENGER_V1_ABI, claim: MESSAGE_TRANSMITTER_V1_ABI }
    : { burn: TOKEN_MESSENGER_V2_ABI, claim: MESSAGE_TRANSMITTER_V2_ABI }
}

export const evmDriver: CanaryDriver = {
  type: 'evm',
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  defaultMinNative: 200_000_000_000_000n, // 0.0002 native

  address(secret) {
    return privateKeyToAccount(secret as Hex).address
  },

  async nativeBalance(chain, address) {
    return await publicClient(chain).getBalance({ address: address as Address })
  },

  async usdcBalance(chain, address) {
    return await publicClient(chain).readContract({
      address: chain.usdc_address as Address,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [address as Address],
    })
  },

  async burn(ctx: DriverContext, req: BurnRequest): Promise<string> {
    const { chain, version, amountUnits, destDomain, destChain, destAddress, fast, secret } = req
    const { tokenMessenger } = contractsFor(ctx, version, chain.domain)
    const account = privateKeyToAccount(secret as Hex)
    const pub = publicClient(chain)
    const wallet = walletClient(chain, secret)

    const onchainId = await pub.getChainId()
    if (chain.chain_id != null && onchainId !== chain.chain_id) {
      throw new Error(`${chain.name}: RPC chain id ${onchainId} != configured ${chain.chain_id}`)
    }

    const usdc = chain.usdc_address as Address
    const tm = tokenMessenger as Address

    const allowance = await pub.readContract({
      address: usdc,
      abi: ERC20,
      functionName: 'allowance',
      args: [account.address, tm],
    })
    if (allowance < amountUnits) {
      ctx.log(`${chain.name}: approving ${formatUnits(amountUnits, chain.usdc_decimals)} USDC to ${tm}`)
      const hash = await wallet.writeContract({
        address: usdc,
        abi: ERC20,
        functionName: 'approve',
        args: [tm, amountUnits],
        account,
        chain: toViemChain(chain),
      })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`approve failed: ${hash}`)
    }

    // Stellar G-addresses must be reached through CctpForwarder + hook data.
    const stellarAccount = destChain.chain_type === 'stellar' && isStellarAccount(destAddress)
    let mintRecipient: Hex
    let hookData: Hex | undefined
    if (stellarAccount) {
      const forwarder = STELLAR_CCTP_FORWARDER.testnet
      mintRecipient = bytes32(forwarder)
      hookData = buildCctpForwarderHookData(destAddress)
    } else if (destChain.chain_type === 'solana') {
      mintRecipient = solanaUsdcAtaHex(destAddress, destChain.usdc_address)
    } else {
      mintRecipient = bytes32(destAddress)
    }

    if (version === 1) {
      if (hookData) throw new Error('CCTP v1 has no hook path; Stellar destinations require v2')
      return await wallet.writeContract({
        address: tm,
        abi: TOKEN_MESSENGER_V1_ABI,
        functionName: 'depositForBurn',
        args: [amountUnits, destDomain, mintRecipient, usdc],
        account,
        chain: toViemChain(chain),
      })
    }

    const finalityThreshold = fast ? 1000 : 2000
    const maxFee = await fetchCircleMaxFee({
      mode: 'testnet',
      srcDomain: chain.domain,
      destDomain,
      finalityThreshold,
      amountUnits,
    })

    if (hookData) {
      return await wallet.writeContract({
        address: tm,
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: 'depositForBurnWithHook',
        args: [amountUnits, destDomain, mintRecipient, usdc, ZERO_BYTES32, maxFee, finalityThreshold, hookData],
        account,
        chain: toViemChain(chain),
      })
    }

    return await wallet.writeContract({
      address: tm,
      abi: TOKEN_MESSENGER_V2_ABI,
      functionName: 'depositForBurn',
      args: [amountUnits, destDomain, mintRecipient, usdc, ZERO_BYTES32, maxFee, finalityThreshold],
      account,
      chain: toViemChain(chain),
    })
  },

  async claim(ctx: DriverContext, req: ClaimRequest): Promise<string> {
    const { chain, version, message, attestation, secret } = req
    const { messageTransmitter } = contractsFor(ctx, version, chain.domain)
    const account = privateKeyToAccount(secret as Hex)
    const pub = publicClient(chain)
    const wallet = walletClient(chain, secret)
    const abi = abiFor(version).claim

    const hash = await wallet.writeContract({
      address: messageTransmitter as Address,
      abi,
      functionName: 'receiveMessage',
      args: [message as Hex, attestation as Hex],
      account,
      chain: toViemChain(chain),
    })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`claim reverted: ${hash}`)
    return hash
  },

  async waitForBurn(chain, txHash) {
    const receipt = await publicClient(chain).waitForTransactionReceipt({ hash: txHash as Hex })
    if (receipt.status !== 'success') throw new Error(`burn reverted: ${txHash}`)
  },
}
