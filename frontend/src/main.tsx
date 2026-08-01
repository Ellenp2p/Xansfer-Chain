import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WalletProvider } from '@xansfer/wallet-connect'
import '@xansfer/wallet-connect/styles.css'
import { useNetworkMode } from './stores/networkMode'
import { getChains } from './config/chains'
import App from './App'
import './index.css'

function Root() {
  const mode = useNetworkMode((s) => s.mode)
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } },
  }))

  const chains = getChains(mode)

  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Remount on network switch — resets all wallet/query state */}
        <WalletProvider
          key={mode}
          mode={mode}
          chains={chains}
          solanaRpc={import.meta.env.VITE_SOLANA_RPC}
          appName="Xansfer"
        >
          <BrowserRouter basename={import.meta.env.BASE_URL}>
            <App />
          </BrowserRouter>
        </WalletProvider>
      </QueryClientProvider>
    </React.StrictMode>
  )
}

export default function Entry() {
  return <Root />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Entry />)
