import './styles.css'

// Core types
export type {
  ChainConfig,
  ChainType,
  WalletInfo,
  WalletSlot,
  WalletState,
  ChainActions,
  WalletActions,
} from './core/types'
export { ALL_CHAIN_TYPES, emptyWalletState } from './core/types'

// Context / provider
export { WalletProvider, useWallet, useWalletState, useWagmiConfig } from './context/WalletProvider'
export type { WalletProviderProps, WalletContextValue, ConnectorOption } from './context/WalletProvider'

// UI components
export { ConnectWallet } from './components/ConnectWallet'
export type { ConnectWalletProps } from './components/ConnectWallet'
export { WalletModal } from './components/WalletModal'
export type { WalletModalProps } from './components/WalletModal'
export { ChainIcon } from './components/ChainIcon'
export type { ChainIconProps } from './components/ChainIcon'

// Chain icons
export { CHAIN_COLORS, XANSFER_CHAIN_ICONS, getChainColor } from './icons'
