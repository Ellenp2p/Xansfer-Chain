import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { ArrowLeftRight, History, Layers, Menu, Search, X } from 'lucide-react'
import { ConnectWallet } from '@xansfer/wallet-connect'
import NetworkToggle from './NetworkToggle'
import { withModePrefix, type Mode } from '../config/chains'

const NAV = [
  { to: '/', label: 'Transfer', icon: ArrowLeftRight },
  { to: '/history', label: 'History', icon: History },
  { to: '/lookup', label: 'Lookup', icon: Search },
]

export default function Header({ mode }: { mode: Mode }) {
  const [menuOpen, setMenuOpen] = useState(false)

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition hover:text-white ${
      isActive ? 'text-white bg-gray-800' : 'text-gray-400'
    }`

  return (
    <header className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-2 px-2 sm:px-4 py-2.5 sm:py-3">
        {/* Mobile hamburger — far left */}
        <button
          onClick={() => setMenuOpen(true)}
          className="sm:hidden flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-700 bg-gray-800 text-gray-300"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link to={withModePrefix(mode, '/')} className="flex items-center gap-1.5 sm:gap-2 text-base sm:text-lg font-bold text-white shrink-0">
          <Layers className="h-5 w-5 sm:h-6 sm:w-6 text-brand-500" />
          <span className="hidden sm:inline">Xansfer</span>
          {mode === 'testnet' && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">TESTNET</span>
          )}
        </Link>

        {/* Desktop nav */}
        <nav className="hidden sm:flex items-center gap-1 text-sm">
          {NAV.map((item) => (
            <NavLink key={item.to} to={withModePrefix(mode, item.to)} end={item.to === '/'} className={navLinkClass}>
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <NetworkToggle />
          <ConnectWallet />
        </div>
      </div>

      {/* Mobile full-width drawer */}
      {menuOpen && (
        <div className="sm:hidden fixed inset-0 z-[90]">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <div className="absolute top-0 inset-x-0 w-full bg-gray-900 border-b border-gray-800 shadow-xl">
            <div className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
              <span className="font-bold text-white">Xansfer</span>
              <button onClick={() => setMenuOpen(false)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-3">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={withModePrefix(mode, item.to)}
                  end={item.to === '/'}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition hover:bg-gray-800 ${
                      isActive ? 'text-white bg-gray-800' : 'text-gray-300'
                    }`
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      )}
    </header>
  )
}
