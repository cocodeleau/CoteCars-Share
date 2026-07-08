import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import vercelApiDev from './vite-plugins/api-dev.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), vercelApiDev()],
  server: {
    port: 5180,
    strictPort: true,
  },
})
