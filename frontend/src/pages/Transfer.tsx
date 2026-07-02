import TransferForm from '../components/TransferForm'
import { Layers } from 'lucide-react'

export default function Transfer() {
  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="text-center">
        <h1 className="flex items-center justify-center gap-3 text-2xl sm:text-3xl font-bold">
          <Layers className="h-7 w-7 sm:h-8 sm:w-8 text-brand-500" />
          Cross-Chain USDC Transfer
        </h1>
        <p className="mt-2 text-sm sm:text-base text-gray-400">
          Transfer USDC across 27+ chains using Circle CCTP v2
        </p>
      </div>
      <TransferForm />
    </div>
  )
}
