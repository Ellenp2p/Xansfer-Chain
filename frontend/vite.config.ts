import { defineConfig, createLogger } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Dependencies occasionally import Node.js built-ins (crypto, stream, vm).
// Vite externalizes these for the browser. They do not affect the app because
// the code paths that require them are not exercised at runtime.
const logger = createLogger()
const originalWarn = logger.warn
logger.warn = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('has been externalized for browser compatibility')) {
    return
  }
  originalWarn(msg, options)
}

export default defineConfig({
  customLogger: logger,
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    // Wallet adapter libraries (RainbowKit, wagmi, Torus, etc.) produce a large
    // single chunk. This is expected for the current bundle; code-splitting
    // individual adapters would require larger refactoring.
    chunkSizeWarningLimit: 2000,
  },
})
