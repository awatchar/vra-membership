import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * All tests run inside workerd through `@cloudflare/vitest-pool-workers`, so
 * suites exercise the same runtime, D1 and R2 bindings as production.
 *
 * Provider calls are always mocked: no test may reach iApp, SlipOK or Resend
 * (AGENTS.md), which `PROVIDER_MODE=mock` below enforces.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'development',
          PROVIDER_MODE: 'mock',
          APP_BASE_URL: 'http://localhost:8787',
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
