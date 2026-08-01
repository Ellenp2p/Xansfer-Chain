import { Link } from 'react-router-dom'
import { ArrowLeftRight, History, Layers, Search } from 'lucide-react'
import { ConnectWallet } from '@xansfer/wallet-connect'
import NetworkToggle from './NetworkToggle'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-2 sm:px-4 py-2.5 sm:py-3">
        <Link to="/" className="flex items-center gap-1.5 sm:gap-2 text-base sm:text-lg font-bold text-white shrink-0">
          <Layers className="h-5 w-5 sm:h-6 sm:w-6 text-brand-500" />
          <span className="hidden sm:inline">Xansfer</span>
        </Link>
        <nav className="flex items-center gap-3 sm:gap-6 text-sm text-gray-400">
          <Link
            to="/"
            className="flex items-center gap-1.5 transition hover:text-white"
          >
            <ArrowLeftRight className="h-4 w-4" />
            <span className="hidden sm:inline">Transfer</span>
          </Link>
          <Link
            to="/history"
            className="flex items-center gap-1.5 transition hover:text-white"
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">History</span>
          </Link>
          <Link
            to="/lookup"
            className="flex items-center gap-1.5 transition hover:text-white"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">Lookup</span>
          </Link>
        </nav>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <NetworkToggle />
          <ConnectWallet />
        </div>
      </div>
    </header>
  )
}
