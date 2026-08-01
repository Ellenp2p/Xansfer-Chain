import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    // Chain icons are emitted as separate files (not inlined base64).
    assetsInlineLimit: 1,
    rollupOptions: {
      // Externalize bare package imports (react, wagmi, @scope/pkg, ...).
      // Relative imports, absolute source paths and rollup virtual ids bundle.
      external: (id: string) => {
        if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\0')) return false
        if (/^[A-Za-z]:[\\/]/.test(id)) return false
        return true
      },
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith('.css') ? 'styles.css' : 'assets/[name][extname]',
      },
    },
  },
})
