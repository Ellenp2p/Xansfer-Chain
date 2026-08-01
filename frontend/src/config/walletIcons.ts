/**
 * Wallet icon overrides for @xansfer/wallet-connect.
 *
 * Base-aware so they resolve under any deployment path (e.g. /Xansfer-Chain/).
 * Solana/Aptos/Sui wallet icons come from their SDKs; only EVM needs local art.
 */
const base = import.meta.env.BASE_URL

export const WALLET_ICONS: Record<string, string> = {
  // wagmi connector ids
  injected: `${base}wallets/metamask.svg`,
  coinbaseWallet: `${base}wallets/coinbase.svg`,
  // wallet names (fallback keys)
  MetaMask: `${base}wallets/metamask.svg`,
  'Coinbase Wallet': `${base}wallets/coinbase.svg`,
}
