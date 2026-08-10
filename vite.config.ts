import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { bridgePlugin } from './bridge/plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), bridgePlugin()],
  server: {
    // Allow tunneling tools like ngrok to reach the dev server.
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io'],
  },
  test: {
    // Library tests run in node; the App smoke test opts into jsdom with a
    // per-file `@vitest-environment` comment.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'bridge/**/*.test.ts'],
  },
})
