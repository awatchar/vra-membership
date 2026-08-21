import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * All tests run inside workerd through `@cloudflare/vitest-pool-workers`, so
 * suites exercise the same runtime, D1 and R2 bindings as production.
 *
 * Provider calls are always mocked: no test may reach iApp, SlipOK or Resend
 * (AGENTS.md), which `PROVIDER_MODE=mock` below enforces.
 *
 * `TEST_MIGRATIONS` carries the real migration files into the test worker so
 * schema tests run against the same SQL that ships to production, rather than
 * against a hand-written copy that can drift.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'development',
            PROVIDER_MODE: 'mock',
            APP_BASE_URL: 'http://localhost:8787',
            // Test-only key material. Endpoints that protect the citizen ID or
            // issue a capability token derive both from this secret.
            PII_ENCRYPTION_KEY: 'test-only-pii-encryption-key-material-0123456789',
            // Test-only Svix signing secret, so webhook tests verify real
            // signatures rather than a mock that answers "valid". The value is
            // valid base64 and says `testonly` in plain sight, which is what
            // exempts it from the hard-coded-secret check in
            // `scripts/validate-repository.ps1`.
            RESEND_WEBHOOK_SECRET: 'whsec_testonlywebhooksecret123',
            MANAGER_EMAIL: 'manager@example.test',
            // Invented account details. `receiverAccountDigits` from the mock
            // slip provider is `1234`, which has to appear in order inside the
            // configured account for the receiver check to pass.
            // Access team and audience for the admin tests, which mint real
            // RS256 tokens against a JWKS the test itself serves.
            CF_ACCESS_TEAM_DOMAIN: 'vra-test',
            CF_ACCESS_AUD: 'test-only-access-audience-tag',
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
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup/storage.ts'],
    },
  };
});
