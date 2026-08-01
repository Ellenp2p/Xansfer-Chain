/**
 * Chain icon registry.
 *
 * Icons are intentionally NOT bundled with the package: chain icons are
 * project-specific assets. The host app passes them to <ChainIcon iconMap>
 * or <WalletProvider chainIcons>. A brand-color monogram fallback is used
 * for any domain without an icon.
 */

/** Brand-ish accent colors used for the fallback monogram badge. */
export const CHAIN_COLORS: Record<number, string> = {
  0: '#627eea',
  1: '#e84142',
  2: '#ff0420',
  3: '#28a0f0',
  5: '#9945ff',
  6: '#0052ff',
  7: '#8247e5',
  8: '#4da2ff',
  10: '#0d1b2a',
  11: '#121212',
  12: '#ff0f0f',
  13: '#00d18c',
  14: '#000000',
  15: '#6b5bff',
  16: '#9747ff',
  17: '#f3ba2f',
  18: '#d3d3d3',
  19: '#0d3b3f',
  21: '#ff0420',
  22: '#f5a442',
  25: '#ff8b3e',
  26: '#414a4c',
  27: '#7d00ff',
  28: '#5b17d9',
  29: '#46b2f0',
  30: '#0c0024',
  31: '#a58a4e',
  32: '#002d74',
  33: '#181c3c',
}

export function getChainColor(domain: number): string {
  return CHAIN_COLORS[domain] ?? '#6366f1'
}

/** Convenience icon map for the Xansfer chain set (public/ static assets). */
export const XANSFER_CHAIN_ICONS: Record<number, string> = {
  0: '/chains/ethereum.png',
  1: '/chains/avalanchec.png',
  2: '/chains/optimism.png',
  3: '/chains/arbitrum.png',
  5: '/chains/solana.png',
  6: '/chains/base.png',
  7: '/chains/polygon.png',
  8: '/chains/sui.png',
  10: '/chains/unichain.jpg',
  11: '/chains/linea.png',
  12: '/chains/codex.jpg',
  13: '/chains/sonic.png',
  14: '/chains/aptos.png',
  15: '/chains/monad.png',
  16: '/chains/sei.png',
  17: '/chains/binance.png',
  18: '/chains/xdc.png',
  19: '/chains/hyperevm.png',
  21: '/chains/ink.jpg',
  22: '/chains/plume.jpg',
  26: '/chains/arc.jpg',
  27: '/chains/stellar.png',
  29: '/chains/injective.jpg',
  30: '/chains/morph.jpg',
  31: '/chains/pharos.jpg',
  32: '/chains/cronos.png',
}
