import { env } from 'cloudflare:workers';
import { createRepository } from '../../src/worker/db';
import type { Repository } from '../../src/worker/db';
import { createCitizenIdProtection } from '../../src/worker/lib/crypto';

/**
 * Synthetic test data. Every value here is invented and cannot be traced to a
 * real person: names are literal Thai words for "test", the citizen ID is a
 * sequential pattern, and email addresses use the reserved `.test` TLD.
 */

export const TEST_KEY = 'test-only-pii-encryption-key-material-0123456789';
export const TEST_CITIZEN_ID = '1234567890121';
export const OTHER_TEST_CITIZEN_ID = '1234567890139';

export function repository(overrides?: Parameters<typeof createRepository>[1]): Repository {
  return createRepository(env.DB, overrides);
}

/** Creates an application with protected identity data, returning its id. */
export async function seedApplication(
  repo: Repository,
  citizenId: string = TEST_CITIZEN_ID,
): Promise<string> {
  const protection = await createCitizenIdProtection(TEST_KEY);
  const application = await repo.applications.create({
    citizenIdHash: await protection.hash(citizenId),
    citizenIdCiphertext: await protection.encrypt(citizenId),
    title: 'นาย',
    firstName: 'ทดสอบ',
    lastName: 'ระบบสมัคร',
    firstNameEn: 'Thodsob',
    lastNameEn: 'Rabobsamak',
    birthDate: '1990-01-15',
    cardExpiryDate: '2032-01-14',
  });
  return application.id;
}

export const FIVE_YEAR_SATANG = 50_000;
export const LIFETIME_SATANG = 200_000;
