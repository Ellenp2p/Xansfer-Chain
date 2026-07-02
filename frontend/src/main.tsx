import React, { useState, useEffect, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { mainnetConfig, testnetConfig } from './config/wagmi'
import { useNetworkMode } from './stores/networkMode'
import { useWalletStore } from './stores/walletStore'
import SolanaWalletProvider from './providers/SolanaWalletProvider'
import AptosWalletProvider from './providers/AptosWalletProvider'
import SuiWalletProvider from './providers/SuiWalletProvider'
import { StellarWalletProvider } from './providers/StellarWalletProvider'
import App from './App'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'

function NetworkProvider({ children }: { children: ReactNode }) {
  const mode = useNetworkMode((s) => s.mode)
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } },
  }))

  // Clear EVM wallet state when network mode changes (defer to avoid render-phase update)
  useEffect(() => {
    const timer = setTimeout(() => useWalletStore.getState().setEvmWallet(null), 0)
    return () => clearTimeout(timer)
  }, [mode])

  // Force full remount when mode changes — resets all wagmi/query state
  const [key, setKey] = useState(mode)
  useEffect(() => { setKey(mode) }, [mode])

  const wagmiConfig = mode === 'testnet' ? testnetConfig : mainnetConfig

  return (
    <WagmiProvider key={key} config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: mode === 'testnet' ? '#f59e0b' : '#1a6ff5',
            accentColorForeground: 'white',
            borderRadius: 'medium',
            fontStack: 'system',
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default function Root() {
  return (
    <React.StrictMode>
      <NetworkProvider>
        <SolanaWalletProvider>
          <AptosWalletProvider>
            <SuiWalletProvider>
              <StellarWalletProvider>
                <BrowserRouter>
                  <App />
                </BrowserRouter>
              </StellarWalletProvider>
            </SuiWalletProvider>
          </AptosWalletProvider>
        </SolanaWalletProvider>
      </NetworkProvider>
    </React.StrictMode>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Root />)
