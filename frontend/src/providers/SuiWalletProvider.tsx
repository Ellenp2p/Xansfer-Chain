import { type ReactNode } from 'react'
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { useNetworkMode } from '../stores/networkMode'

const SUI_RPC_URLS: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
}

export default function SuiWalletProvider({ children }: { children: ReactNode }) {
  const mode = useNetworkMode((s) => s.mode)

  const network = mode === 'testnet' ? 'testnet' : 'mainnet'

  return (
    <SuiClientProvider
      networks={{
        mainnet: { url: SUI_RPC_URLS.mainnet, network: 'mainnet' },
        testnet: { url: SUI_RPC_URLS.testnet, network: 'testnet' },
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
