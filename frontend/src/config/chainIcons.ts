/**
 * Chain icon URLs, base-aware.
 *
 * Vite rewrites import.meta.env.BASE_URL at build time (e.g. "/" locally,
 * "/Xansfer-Chain/" on GitHub Pages), so these resolve correctly regardless of
 * where the site is hosted. Files live in frontend/public/chains/.
 */
const FILES: Record<number, string> = {
  0: 'ethereum.png',
  1: 'avalanchec.png',
  2: 'optimism.png',
  3: 'arbitrum.png',
  5: 'solana.png',
  6: 'base.png',
  7: 'polygon.png',
  8: 'sui.png',
  10: 'unichain.jpg',
  11: 'linea.png',
  12: 'codex.jpg',
  13: 'sonic.png',
  14: 'aptos.png',
  15: 'monad.png',
  16: 'sei.png',
  17: 'binance.png',
  18: 'xdc.png',
  19: 'hyperevm.png',
  21: 'ink.jpg',
  22: 'plume.jpg',
  26: 'arc.jpg',
  27: 'stellar.png',
  29: 'injective.jpg',
  30: 'morph.jpg',
  31: 'pharos.jpg',
  32: 'cronos.png',
}

const base = import.meta.env.BASE_URL

export const CHAIN_ICONS: Record<number, string> = Object.fromEntries(
  Object.entries(FILES).map(([domain, file]) => [Number(domain), `${base}chains/${file}`]),
) as Record<number, string>
