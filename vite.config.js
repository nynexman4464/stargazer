import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // satellite.js v7's root entry pulls in its WASM build (top-level await
      // breaks the production bundle); alias to the pure-JS SGP4 modules.
      'satellite.js': new URL('./src/lib/satpure.js', import.meta.url).pathname,
    },
  },
})
