import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

/**
 * Test storage lifecycle.
 *
 * Migrations come from the real `migrations/*.sql` files, so schema constraints
 * are exercised exactly as deployed rather than against a hand-written copy.
 *
 * The pool does not roll back storage between individual tests in this
 * configuration, so every test starts from an explicitly emptied database and
 * bucket. Without this, a suite would silently depend on rows another test
 * happened to leave behind.
 */
/**
 * `TEST_MIGRATIONS` is injected by `vitest.config.ts` and exists only under
 * test. It is read through a local cast rather than by augmenting
 * `Cloudflare.Env`, so production code never sees a binding it cannot have.
 */
const testEnv = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

/** Child tables first: `delete` respects foreign keys when they are enforced. */
const TABLES_IN_DELETION_ORDER = [
  'application_events',
  'emails',
  'receipts',
  'payments',
  'addresses',
  'applications',
] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of TABLES_IN_DELETION_ORDER) {
    await env.DB.prepare(`delete from ${table}`).run();
  }

  let cursor: string | undefined;
  do {
    const listing = await env.MEMBER_PHOTOS.list(cursor ? { cursor } : {});
    if (listing.objects.length > 0) {
      await env.MEMBER_PHOTOS.delete(listing.objects.map((object) => object.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
});
