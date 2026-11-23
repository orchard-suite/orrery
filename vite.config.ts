import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// The release the page is built from, so it can tell when the hub serving it has moved on.
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_ORRERY_VERSION': JSON.stringify(version) },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1/ingest/': 'http://localhost:8081',
      '/v1/': 'http://localhost:8080',
      '/mcp': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/web/test-storage.ts'],
    env: { LOG_LEVEL: 'error' },
    fileParallelism: false,
    // Each file starts a hub against Postgres. On a runner whose disk is
    // shared and busy that can take far longer than on a laptop.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
