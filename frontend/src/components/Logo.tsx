interface LogoProps {
  className?: string
  size?: number
}

/**
 * Xansfer brand logo.
 *
 * This is an original vector mark created for the project. It does not use any
 * third-party copyrighted or trademarked imagery.
 */
export function Logo({ className, size = 32 }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      width={size}
      height={size}
      className={className}
      aria-label="Xansfer logo"
    >
      <defs>
        <linearGradient
          id="xansfer-gradient"
          x1="0"
          y1="0"
          x2="512"
          y2="512"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3390FF" />
          <stop offset="1" stopColor="#135AE1" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" fill="url(#xansfer-gradient)" />
      <path
        d="M148 180 L256 264 L364 180"
        stroke="white"
        strokeWidth="48"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M148 332 L256 248 L364 332"
        stroke="white"
        strokeWidth="48"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  )
}
