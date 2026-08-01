import { getChainColor } from '../icons'

export interface ChainIconProps {
  domain: number
  name?: string
  size?: number
  className?: string
  /** Optional domain → icon URL map (host app assets). Empty → monogram fallback. */
  iconMap?: Record<number, string>
}

/**
 * Chain logo. Renders `iconMap[domain]` when provided; otherwise falls back
 * to a brand-color monogram badge.
 */
export function ChainIcon({ domain, name, size = 20, className, iconMap }: ChainIconProps) {
  const src = iconMap?.[domain]
  const label = name || `Chain ${domain}`

  if (src) {
    return (
      <img
        src={src}
        alt={label}
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }

  return (
    <span
      className={`xw-chain-fallback ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        lineHeight: `${size}px`,
        background: getChainColor(domain),
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {label.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '#'}
    </span>
  )
}
