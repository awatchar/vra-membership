import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the browser bundle into `dist/client`, which `wrangler.jsonc` serves
 * through the Workers assets binding.
 *
 * During local development `vite` proxies `/api` to `wrangler dev` so the
 * browser never needs provider credentials (see docs/development.md).
 */
export default defineConfig({
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
});
