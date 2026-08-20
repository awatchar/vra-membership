import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { TURNSTILE_TOKEN_HEADER } from '../../src/worker/security/turnstile';
import { ACCESS_TOKEN_HEADER } from '../../src/worker/services/application-access';
import { formatBaht, membershipPlan } from '../../src/worker/services/membership';
import { repository } from '../support/fixtures';

/**
 * The application endpoints.
 *
 * `PII_ENCRYPTION_KEY` is provided to the test worker through
 * `vitest.config.ts`, because these handlers derive both the citizen ID
 * protection and the capability hash from it.
 */

const CITIZEN_ID = '1234567890121';
const OTHER_CITIZEN_ID = '1234567890139';

const VALID_ADDRESS = {
  idAddress: '999 หมู่ 9',
  idSubdistrict: 'ตัวอย่าง',
  idDistrict: 'ตัวอย่าง',
  idProvince: 'กรุงเทพมหานคร',
  mailSameAsId: true,
  mailPostcode: '10200',
};

function createRequest(body: unknown, clientIp = '203.0.113.40'): Request {
  return new Request('http://localhost/api/applications', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': clientIp,
      [TURNSTILE_TOKEN_HEADER]: 'test-token',
    },
    body: JSON.stringify(body),
  });
}

function readRequest(id: string, token: string | null): Request {
  return new Request(`http://localhost/api/applications/${id}`, {
    headers: token ? { [ACCESS_TOKEN_HEADER]: token } : {},
  });
}

function patchRequest(id: string, token: string | null, body: unknown): Request {
  return new Request(`http://localhost/api/applications/${id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { [ACCESS_TOKEN_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
  });
}

interface CreatedBody {
  application: { id: string; status: string; citizenIdTail: string };
  accessToken: string;
  hasPreviousApplication: boolean;
}

async function createApplication(citizenId = CITIZEN_ID, ip = '203.0.113.40') {
  const response = await exports.default.fetch(createRequest({ citizenId }, ip));
  expect(response.status).toBe(201);
  return response.json<CreatedBody>();
}

describe('POST /api/applications', () => {
  it('creates an application and returns the capability token once', async () => {
    const body = await createApplication();

    expect(body.application.status).toBe('DRAFT');
    expect(body.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.application.citizenIdTail).toBe('0121');
  });

  it('never returns the full citizen ID', async () => {
    const response = await exports.default.fetch(createRequest({ citizenId: CITIZEN_ID }));
    const text = await response.text();

    expect(text).not.toContain(CITIZEN_ID);
    expect(text).toContain('0121');
  });

  it('stores only a hash of the capability token', async () => {
    const body = await createApplication();

    const record = await repository().applications.findById(body.application.id);
    // A copy of the database must not hand over working capabilities.
    expect(record?.accessTokenHash).toBeTruthy();
    expect(record?.accessTokenHash).not.toBe(body.accessToken);
  });

  it('encrypts the citizen ID at rest', async () => {
    const body = await createApplication();

    const { results } = await env.DB.prepare(
      'select citizen_id_ciphertext, citizen_id_hash from applications where id = ?',
    )
      .bind(body.application.id)
      .all<{ citizen_id_ciphertext: string; citizen_id_hash: string }>();

    expect(results[0]!.citizen_id_ciphertext.startsWith('v1.')).toBe(true);
    expect(results[0]!.citizen_id_ciphertext).not.toContain(CITIZEN_ID);
    expect(results[0]!.citizen_id_hash).not.toContain(CITIZEN_ID);
  });

  it('rejects a citizen ID with a bad check digit', async () => {
    const response = await exports.default.fetch(createRequest({ citizenId: '1234567890123' }));

    expect(response.status).toBe(422);
  });

  it('accepts the formatting printed on the card', async () => {
    const response = await exports.default.fetch(createRequest({ citizenId: '1-2345-67890-12-1' }));

    expect(response.status).toBe(201);
    await expect(response.json<CreatedBody>()).resolves.toMatchObject({
      application: { citizenIdTail: '0121' },
    });
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await exports.default.fetch(
      createRequest({ citizenId: CITIZEN_ID, religion: 'พุทธ' }),
    );

    expect(response.status).toBe(422);
  });

  it('reports a previous application without blocking it', async () => {
    await createApplication(CITIZEN_ID, '203.0.113.41');
    const second = await createApplication(CITIZEN_ID, '203.0.113.42');

    // Renewals are expected (Issue #1 section 79), so this is information.
    expect(second.hasPreviousApplication).toBe(true);
  });

  it('does not report a previous application for a different person', async () => {
    await createApplication(CITIZEN_ID, '203.0.113.43');
    const other = await createApplication(OTHER_CITIZEN_ID, '203.0.113.44');

    expect(other.hasPreviousApplication).toBe(false);
  });

  it('records an audit event carrying no personal data', async () => {
    const body = await createApplication();

    const events = await repository().events.listByApplicationId(body.application.id);
    expect(events.map((event) => event.eventType)).toContain('APPLICATION_CREATED');
    expect(JSON.stringify(events)).not.toContain(CITIZEN_ID);
  });

  it('refuses without a Turnstile token', async () => {
    const response = await exports.default.fetch(
      new Request('http://localhost/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ citizenId: CITIZEN_ID }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('does not cache the response', async () => {
    const response = await exports.default.fetch(createRequest({ citizenId: CITIZEN_ID }));

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/applications/:id', () => {
  it('returns the application to the holder of the token', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      readRequest(created.application.id, created.accessToken),
    );

    expect(response.status).toBe(200);
    await expect(response.json<{ application: { id: string } }>()).resolves.toMatchObject({
      application: { id: created.application.id },
    });
  });

  it('refuses a request with no token', async () => {
    const created = await createApplication();

    // Knowing the id is not enough. An id turns up in browser history, in
    // screenshots and in support tickets; it is not a secret.
    const response = await exports.default.fetch(readRequest(created.application.id, null));

    expect(response.status).toBe(404);
  });

  it('refuses a wrong token', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      readRequest(created.application.id, 'f'.repeat(64)),
    );

    expect(response.status).toBe(404);
  });

  it('refuses one applicant reading another application', async () => {
    const mine = await createApplication(CITIZEN_ID, '203.0.113.45');
    const theirs = await createApplication(OTHER_CITIZEN_ID, '203.0.113.46');

    const response = await exports.default.fetch(
      readRequest(theirs.application.id, mine.accessToken),
    );

    expect(response.status).toBe(404);
  });

  it('answers the same way for a wrong token and a missing application', async () => {
    const created = await createApplication();

    const wrongToken = await exports.default.fetch(
      readRequest(created.application.id, 'a'.repeat(64)),
    );
    const missing = await exports.default.fetch(readRequest(crypto.randomUUID(), 'a'.repeat(64)));

    // Different answers would let a caller confirm which application ids exist.
    // `requestId` is deliberately unique per request, so it is excluded rather
    // than compared.
    const strip = async (response: Response) => {
      const body = await response.json<{ error: Record<string, unknown> }>();
      const { requestId: _correlation, ...error } = body.error;
      return error;
    };

    expect(wrongToken.status).toBe(missing.status);
    expect(await strip(wrongToken)).toEqual(await strip(missing));
  });

  it('rejects an id that is not a uuid', async () => {
    const response = await exports.default.fetch(readRequest('not-a-uuid', 'a'.repeat(64)));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('PATCH /api/applications/:id', () => {
  it('updates contact details', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, {
        phone: '0800000000',
        email: 'member@example.test',
        callsign: 'HS0TEST',
      }),
    );

    expect(response.status).toBe(200);
    await expect(
      response.json<{ application: { email: string; callsign: string } }>(),
    ).resolves.toMatchObject({
      application: { email: 'member@example.test', callsign: 'HS0TEST' },
    });
  });

  it('resolves the membership amount on the server', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, { membershipType: 'LIFETIME' }),
    );

    await expect(
      response.json<{ application: { membershipAmountSatang: number } }>(),
    ).resolves.toMatchObject({
      application: { membershipAmountSatang: membershipPlan('LIFETIME').amountSatang },
    });
  });

  it('rejects a client-supplied amount instead of ignoring it', async () => {
    const created = await createApplication();

    // A value the payer controls must never decide what the payer owes, and
    // rejecting says so rather than hiding it.
    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, {
        membershipType: 'LIFETIME',
        amount: 1,
      }),
    );

    expect(response.status).toBe(422);

    const record = await repository().applications.findById(created.application.id);
    expect(record?.membershipAmountSatang).toBeNull();
  });

  it('stores an address that copies the ID card', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, { address: VALID_ADDRESS }),
    );

    expect(response.status).toBe(200);
    const address = await repository().addresses.findByApplicationId(created.application.id);
    expect(address).toMatchObject({
      mailSameAsId: true,
      mailPostcode: '10200',
      // Mirrored so the manager reads one address without resolving a flag.
      mailProvince: 'กรุงเทพมหานคร',
    });
  });

  it('requires a postcode even when copying the ID-card address', async () => {
    const created = await createApplication();
    const { mailPostcode: _omitted, ...withoutPostcode } = VALID_ADDRESS;

    // The card carries no postcode, so copying it still leaves one unknown.
    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, { address: withoutPostcode }),
    );

    expect(response.status).toBe(422);
  });

  it('rejects a malformed postcode', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, {
        address: { ...VALID_ADDRESS, mailPostcode: '102' },
      }),
    );

    expect(response.status).toBe(422);
  });

  it('requires the full set of fields for a separate mailing address', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, {
        address: { ...VALID_ADDRESS, mailSameAsId: false, mailPostcode: '11000' },
      }),
    );

    expect(response.status).toBe(422);
  });

  it('accepts a complete separate mailing address', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, {
        address: {
          ...VALID_ADDRESS,
          mailSameAsId: false,
          mailRecipient: 'ผู้รับทดสอบ',
          mailAddress: '1 ถนนตัวอย่าง',
          mailSubdistrict: 'ตัวอย่างสอง',
          mailDistrict: 'ตัวอย่างสอง',
          mailProvince: 'นนทบุรี',
          mailPostcode: '11000',
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it('refuses an update without the token', async () => {
    const created = await createApplication();

    const response = await exports.default.fetch(
      patchRequest(created.application.id, null, { callsign: 'HS0TEST' }),
    );

    expect(response.status).toBe(404);
  });

  it('refuses an update once the application is past the editable states', async () => {
    const created = await createApplication();
    const repo = repository();
    await repo.applications.updateStatusIf(created.application.id, ['DRAFT'], 'AWAITING_PAYMENT');
    await repo.applications.updateStatusIf(
      created.application.id,
      ['AWAITING_PAYMENT'],
      'PAYMENT_VERIFIED',
    );

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, { callsign: 'HS0TEST' }),
    );

    expect(response.status).toBe(409);
  });

  it('rejects a malformed email without echoing it', async () => {
    const created = await createApplication();
    const bad = 'not-an-email-1234567890121';

    const response = await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, { email: bad }),
    );

    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain(bad);
    // The field path is useful and safe; the value is not.
    expect(text).toContain('email');
  });

  it('records the membership choice in the audit trail', async () => {
    const created = await createApplication();
    await exports.default.fetch(
      patchRequest(created.application.id, created.accessToken, { membershipType: 'ANNUAL' }),
    );

    const events = await repository().events.listByApplicationId(created.application.id);
    const selected = events.find((event) => event.eventType === 'MEMBERSHIP_SELECTED');
    expect(selected?.metadata).toMatchObject({ membershipType: 'ANNUAL', amountSatang: 50_000 });
  });
});

describe('membership catalogue', () => {
  it('prices the two plans as specified', () => {
    expect(membershipPlan('ANNUAL').amountSatang).toBe(50_000);
    expect(membershipPlan('LIFETIME').amountSatang).toBe(200_000);
  });

  it('formats satang as baht', () => {
    expect(formatBaht(50_000)).toBe('500.00');
    expect(formatBaht(200_000)).toBe('2,000.00');
    expect(formatBaht(1)).toBe('0.01');
  });
});
