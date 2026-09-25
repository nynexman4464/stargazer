import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { execSync } from 'child_process'

// Git SHA + build time, shown in the footer so we can tell which build is live.
let gitSha = 'dev';
try {
  gitSha = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout */
}
const buildTime = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __GIT_SHA__: JSON.stringify(gitSha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  resolve: {
    alias: {
      // satellite.js v7's root entry pulls in its WASM build (top-level await
      // breaks the production bundle); alias to the pure-JS SGP4 modules.
      'satellite.js': new URL('./src/lib/satpure.js', import.meta.url).pathname,
    },
  },
})
