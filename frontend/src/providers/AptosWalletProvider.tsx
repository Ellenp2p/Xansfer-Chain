import { type ReactNode } from 'react'
import { AptosWalletAdapterProvider } from '@aptos-labs/wallet-adapter-react'

export default function AptosWalletProvider({ children }: { children: ReactNode }) {
  return (
    <AptosWalletAdapterProvider autoConnect={true}>
      {children}
    </AptosWalletAdapterProvider>
  )
}

// Re-export useWallet and types for consumers
export { useWallet } from '@aptos-labs/wallet-adapter-react'
export type { InputTransactionData } from '@aptos-labs/wallet-adapter-react'
