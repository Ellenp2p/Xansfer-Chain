import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, History, Layers, Search, Server, RefreshCw } from 'lucide-react'
import WalletButton from './WalletButton'
import WalletPanel from './WalletPanel'
import NetworkToggle from './NetworkToggle'
import { useBackendStore } from '../stores/backendStore'

export default function Header() {
  const [walletOpen, setWalletOpen] = useState(false)
  const backendOnline = useBackendStore((s) => s.online)
  const checking = useBackendStore((s) => s.checking)
  const triggerCheck = async () => {
    useBackendStore.setState({ checking: true })
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch('/api/chains', { signal: controller.signal })
      clearTimeout(timer)
      useBackendStore.getState().markCheck(res.ok)
    } catch {
      useBackendStore.getState().markCheck(false)
    }
  }

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold text-white shrink-0">
            <Layers className="h-5 w-5 sm:h-6 sm:w-6 text-brand-500" />
            <span className="hidden sm:inline">Xansfer</span>
          </Link>
          <nav className="flex items-center gap-4 sm:gap-6 text-sm text-gray-400">
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
          <div className="flex items-center gap-2 shrink-0">
            <NetworkToggle />
            <BackendStatus online={backendOnline} checking={checking} onRecheck={triggerCheck} />
            <WalletButton onClick={() => setWalletOpen(true)} />
          </div>
        </div>
      </header>
      <WalletPanel open={walletOpen} onClose={() => setWalletOpen(false)} />
    </>
  )
}

function BackendStatus({
  online,
  checking,
  onRecheck,
}: {
  online: boolean
  checking: boolean
  onRecheck: () => void
}) {
  if (online) return null

  return (
    <>
      {/* Header badge with hover tooltip */}
      <button
        type="button"
        onClick={onRecheck}
        disabled={checking}
        title="点击重新检测后端连接"
        className="group relative flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-60"
      >
        <Server className="h-3 w-3" />
        <span className="hidden sm:inline">{checking ? 'Checking…' : 'Offline'}</span>
        {checking && <RefreshCw className="h-3 w-3 animate-spin" />}
        <span className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-red-500/40 bg-gray-900 px-2 py-1 text-[11px] text-red-400 opacity-0 shadow-lg transition group-hover:opacity-100">
          后端没连上 · 点击重试
        </span>
      </button>

      {/* Edge indicator */}
      <div className="fixed right-0 top-1/2 z-50 -translate-y-1/2">
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          title="后端没连上，点击重新检测"
          className="group cursor-pointer disabled:cursor-not-allowed"
        >
          <div className="h-20 w-2 rounded-l-full bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.7)] animate-pulse" />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 translate-x-2 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100">
            <div className="whitespace-nowrap rounded-lg border border-red-500/40 bg-gray-900/95 px-3 py-2 text-sm font-medium text-red-400 shadow-xl backdrop-blur-sm">
              后端没连上
            </div>
          </div>
        </button>
      </div>
    </>
  )
}
