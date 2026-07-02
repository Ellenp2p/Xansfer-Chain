import { useState, useEffect, useRef } from 'react'
import { getChains } from '../config/chains'
import { useNetworkMode } from '../stores/networkMode'
import { ChevronDown } from 'lucide-react'

interface Props {
  value: number | null
  onChange: (domain: number) => void
  label: string
  exclude?: number | null
}

const DOMAIN_ICONS: Record<number, string> = {
  0: '🔷', 1: '🔺', 2: '🔴', 3: '🔵', 5: '◎', 6: '🔵', 7: '🟣',
  10: '🔴', 11: '🟢', 13: '👻', 17: '🟡', 25: '⬛', 27: '🌟', 32: '🔵',
}

export default function ChainSelector({ value, onChange, label, exclude }: Props) {
  const [open, setOpen] = useState(false)
  const mode = useNetworkMode((s) => s.mode)
  const ref = useRef<HTMLDivElement>(null)

  const chains = getChains(mode)
  const selected = chains.find((c) => c.domain === value)
  const filtered = chains.filter((c) => c.domain !== exclude)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <label className="mb-1 block text-xs font-medium text-gray-400">{label}</label>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-lg border border-gray-700 bg-gray-800 px-3 sm:px-4 py-2.5 sm:py-3 text-left transition hover:border-gray-600"
      >
        {selected ? (
          <span className="flex items-center gap-2 min-w-0">
            <span className="shrink-0">{DOMAIN_ICONS[selected.domain] ?? '⛓'}</span>
            <span className="font-medium truncate">{selected.name}</span>
            <span className="text-xs text-gray-500 shrink-0">d={selected.domain}</span>
          </span>
        ) : (
          <span className="text-gray-500">Select chain...</span>
        )}
        <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 max-h-64 sm:max-h-72 w-full overflow-y-auto rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
          {filtered.map((chain) => (
            <button
              key={chain.domain}
              onClick={() => {
                onChange(chain.domain)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 text-left text-sm transition hover:bg-gray-700 ${
                value === chain.domain ? 'bg-gray-700 text-white' : 'text-gray-300'
              }`}
            >
              <span className="shrink-0">{DOMAIN_ICONS[chain.domain] ?? '⛓'}</span>
              <span className="font-medium truncate">{chain.name}</span>
              <span className="ml-auto text-xs text-gray-500 shrink-0">d={chain.domain}</span>
              <span className="sm:ml-2 rounded bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400 uppercase shrink-0">
                {chain.chain_type}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
