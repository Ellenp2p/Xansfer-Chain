/**
 * Backend endpoint configuration.
 *
 * Use `VITE_BACKEND_URL` to point the frontend at a deployed backend.
 *   - Dev default (empty / unset): use Vite's `/api` proxy.
 *   - Production build example:
 *       VITE_BACKEND_URL=https://api.xansfer.example.com bun run build
 */
const backendUrl = (import.meta.env.VITE_BACKEND_URL as string | undefined) || ''
const trimmed = backendUrl.replace(/\/$/, '')

export const BACKEND_URL = trimmed

export const API_BASE = trimmed ? `${trimmed}/api` : '/api'

export function getWsUrl(): string {
  if (!trimmed) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${location.host}/ws`
  }

  const url = new URL(trimmed)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  return url.toString()
}
