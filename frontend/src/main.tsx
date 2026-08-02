import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WalletProvider } from '@xansfer/wallet-connect'
import '@xansfer/wallet-connect/styles.css'
import { useNetworkMode } from './stores/networkMode'
import { getChains, modeFromPath } from './config/chains'
import { WALLET_ICONS } from './config/walletIcons'
import App from './App'
import './index.css'

function Root() {
  return (
    <React.StrictMode>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <ModeBound />
      </BrowserRouter>
    </React.StrictMode>
  )
}

/**
 * Network mode is bound to the URL: "/" = mainnet, "/testnet" = testnet.
 * Wallet state is reset on a network switch (key=mode).
 */
function ModeBound() {
  const location = useLocation()
  const mode = modeFromPath(location.pathname)
  const setMode = useNetworkMode((s) => s.setMode)

  useEffect(() => {
    if (useNetworkMode.getState().mode !== mode) setMode(mode)
  }, [mode, setMode])

  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } },
  }))

  const chains = getChains(mode)

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider
        key={mode}
        mode={mode}
        chains={chains}
        solanaRpc={import.meta.env.VITE_SOLANA_RPC}
        appName="Xansfer"
        walletIcons={WALLET_ICONS}
      >
        <App mode={mode} />
      </WalletProvider>
    </QueryClientProvider>
  )
}

export default function Entry() {
  return <Root />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Entry />)
