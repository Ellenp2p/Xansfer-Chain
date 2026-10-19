import { describe, expect, it } from 'vitest'
import { Account as AptosAccount } from '@aptos-labs/ts-sdk'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import {
  assertMnemonic,
  deriveAllWallets,
  deriveWallet,
  DERIVATION_PATHS,
  derivationPath,
  normalizeMnemonic,
  slip10Ed25519,
} from './canaryWallet'

// Well-known Hardhat mnemonic; EVM account 0 is the canonical 0xf39F... address.
const MNEMONIC = 'test test test test test test test test test test test junk'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  return Uint8Array.from(clean.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)))
}

describe('SLIP-0010 ed25519', () => {
  it('matches the spec test vector for m/0\'', () => {
    const seed = hexToBytes('000102030405060708090a0b0c0d0e0f')
    const key = slip10Ed25519(seed, "m/0'")
    expect(Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    )
  })

  it('rejects non-hardened paths', () => {
    expect(() => slip10Ed25519(hexToBytes('00'), 'm/44/148/0')).toThrow(/hardened/)
  })
})

describe('mnemonic handling', () => {
  it('normalises whitespace and case', () => {
    expect(normalizeMnemonic('  TEST test  TEST ')).toBe('test test test')
  })

  it('rejects an invalid mnemonic', () => {
    expect(() => assertMnemonic('not a real mnemonic at all')).toThrow(/BIP39/)
  })
})

describe('derivation paths', () => {
  it('uses the documented per-chain paths', () => {
    expect(derivationPath('evm', 0)).toBe(DERIVATION_PATHS.evm.replace('{i}', '0'))
    expect(derivationPath('stellar', 1)).toBe("m/44'/148'/1'")
    expect(derivationPath('solana', 1)).toBe("m/44'/501'/1'/0'")
    expect(derivationPath('aptos', 0)).toBe("m/44'/637'/0'/0'/0'")
    expect(derivationPath('sui', 0)).toBe("m/44'/784'/0'/0'/0'")
    expect(derivationPath('starknet', 0)).toBeNull()
  })

  it('honours a path override', () => {
    expect(derivationPath('evm', 5, { evm: "m/44'/60'/0'/0/{i}" })).toBe("m/44'/60'/0'/0/5")
  })
})

describe('wallet addresses', () => {
  it('derives the canonical Hardhat EVM accounts', () => {
    expect(deriveWallet(MNEMONIC, 'evm', { index: 0 }).address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(deriveWallet(MNEMONIC, 'evm', { index: 1 }).address).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
  })

  it('matches the Aptos SDK derivation', () => {
    const sdk = AptosAccount.fromDerivationPath({ mnemonic: MNEMONIC, path: "m/44'/637'/0'/0'/0'" })
    expect(deriveWallet(MNEMONIC, 'aptos', { index: 0 }).address).toBe(sdk.accountAddress.toStringLong())
  })

  it('matches the Sui SDK derivation', () => {
    const sdk = Ed25519Keypair.deriveKeypair(MNEMONIC, "m/44'/784'/0'/0'/0'")
    expect(deriveWallet(MNEMONIC, 'sui', { index: 0 }).address).toBe(sdk.toSuiAddress())
  })

  it('derives Stellar and Solana addresses deterministically', () => {
    expect(deriveWallet(MNEMONIC, 'stellar', { index: 0 }).address).toBe(
      'GCRN5PMAG5FM5QLCH7BUZPRQ7UIW37LBZLF2BIDEOSG4ZQ6HYRC45ALA',
    )
    expect(deriveWallet(MNEMONIC, 'stellar', { index: 1 }).address).toBe(
      'GBK4HMMPZU3HGEUR6IT3ZWRRHBD6P4OISMUGFVLF5G2B6H4XRPWPD7WP',
    )
    expect(deriveWallet(MNEMONIC, 'solana', { index: 0 }).address).toBe('oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96')
    expect(deriveWallet(MNEMONIC, 'solana', { index: 1 }).address).toBe('AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD')
  })

  it('returns secrets in the format each driver expects', () => {
    expect(deriveWallet(MNEMONIC, 'evm').secret).toMatch(/^0x[0-9a-f]{64}$/)
    expect(deriveWallet(MNEMONIC, 'aptos').secret).toMatch(/^0x[0-9a-f]{64}$/)
    expect(deriveWallet(MNEMONIC, 'sui').secret).toMatch(/^suiprivkey/)
    expect(deriveWallet(MNEMONIC, 'stellar').secret).toMatch(/^S[A-Z2-7]{55}$/)
    const solanaSecret = JSON.parse(deriveWallet(MNEMONIC, 'solana').secret ?? '[]') as number[]
    expect(solanaSecret).toHaveLength(64)
  })

  it('cannot derive Starknet and says so', () => {
    expect(() => deriveWallet(MNEMONIC, 'starknet')).toThrow(/account implementation/)
    const wallet = deriveWallet(MNEMONIC, 'starknet', { allowUnsupported: true })
    expect(wallet.derived).toBe(false)
    expect(wallet.address).toBe('')
    expect(wallet.secret).toBeNull()
  })

  it('derives every chain type at once', () => {
    const wallets = deriveAllWallets(MNEMONIC, { index: 0 })
    expect(wallets.map((wallet) => wallet.chainType)).toEqual(['evm', 'aptos', 'sui', 'stellar', 'solana', 'starknet'])
    expect(wallets.filter((wallet) => wallet.derived)).toHaveLength(5)
    expect(wallets.find((wallet) => wallet.chainType === 'solana')?.path).toBe("m/44'/501'/0'/0'")
  })
})
