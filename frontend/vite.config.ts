import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  // Base path for the built site. Defaults to "/" (root). Set VITE_BASE when
  // hosting under a sub-path, e.g. GitHub Pages: VITE_BASE=/Xansfer-Chain/
  base: process.env.VITE_BASE || '/',
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
})
