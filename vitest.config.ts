import react from '@vitejs/plugin-react';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Two test projects, because the code under test needs two different runtimes.
 *
 * **worker** runs inside workerd through `@cloudflare/vitest-pool-workers`, so
 * those suites exercise the same runtime, D1 and R2 bindings as production.
 * `TEST_MIGRATIONS` carries the real migration files in, so schema tests run
 * against the SQL that ships rather than a hand-written copy that can drift.
 *
 * **web** runs in jsdom, because the applicant wizard is a browser UI and the
 * things worth testing about it - a field keeping its value across a back
 * navigation, a submit button that cannot be pressed twice, an image that never
 * reaches `localStorage` - only exist in a DOM. Running it in workerd would mean
 * testing the reducer and asserting nothing about the interface built on it.
 *
 * Provider calls are always mocked in both: no test may reach iApp, SlipOK or
 * Resend (AGENTS.md), which `PROVIDER_MODE=mock` enforces on the worker side and
 * a stubbed `fetch` enforces on the web side.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                bindings: {
                  ENVIRONMENT: 'development',
                  PROVIDER_MODE: 'mock',
                  APP_BASE_URL: 'http://localhost:8787',
                  // Test-only key material. Endpoints that protect the citizen
                  // ID or issue a capability token derive both from this secret.
                  PII_ENCRYPTION_KEY: 'test-only-pii-encryption-key-material-0123456789',
                  // Test-only Svix signing secret, so webhook tests verify real
                  // signatures rather than a mock that answers "valid". The
                  // value is valid base64 and says `testonly` in plain sight,
                  // which is what exempts it from the hard-coded-secret check in
                  // `scripts/validate-repository.ps1`.
                  RESEND_WEBHOOK_SECRET: 'whsec_testonlywebhooksecret123',
                  MANAGER_EMAIL: 'manager@example.test',
                  // Access team and audience for the admin tests, which mint
                  // real RS256 tokens against a JWKS the test itself serves.
                  CF_ACCESS_TEAM_DOMAIN: 'vra-test',
                  CF_ACCESS_AUD: 'test-only-access-audience-tag',
                  // Invented account details. `receiverAccountDigits` from the
                  // mock slip provider is `1234`, which has to appear in order
                  // inside the configured account for the receiver check to
                  // pass.
                  VRA_BANK_ACCOUNT: '001234567890',
                  VRA_BANK_NAME: 'ธนาคารตัวอย่าง',
                  VRA_BANK_ACCOUNT_NAME: 'สมาคมนักวิทยุอาสาสมัคร (ตัวอย่าง)',
                  EMAIL_FROM: 'VRA <membership@example.test>',
                  TEST_MIGRATIONS: migrations,
                },
              },
            }),
          ],
          test: {
            name: 'worker',
            include: ['tests/worker/**/*.test.ts', 'tests/unit/**/*.test.ts'],
            setupFiles: ['./tests/setup/storage.ts'],
          },
        },
        {
          plugins: [react()],
          test: {
            name: 'web',
            include: ['tests/web/**/*.test.tsx', 'tests/web/**/*.test.ts'],
            environment: 'jsdom',
            setupFiles: ['./tests/setup/dom.ts'],
          },
        },
      ],
    },
  };
});
