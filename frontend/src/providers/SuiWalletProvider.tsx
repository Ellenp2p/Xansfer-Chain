import { type ReactNode } from 'react'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { useNetworkMode } from '../stores/networkMode'
import { getFullnodeUrl } from '@mysten/sui.js/client'

export default function SuiWalletProvider({ children }: { children: ReactNode }) {
  const mode = useNetworkMode((s) => s.mode)

  const network = mode === 'testnet' ? 'testnet' : 'mainnet'

  return (
    <SuiClientProvider
      networks={{
        mainnet: { url: getFullnodeUrl('mainnet'), network: 'mainnet' },
        testnet: { url: getFullnodeUrl('testnet'), network: 'testnet' },
      }}
      defaultNetwork={network}
    >
      <WalletProvider>
        {children}
      </WalletProvider>
    </SuiClientProvider>
  )
}

// Re-export hooks for consumers
export { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit'
