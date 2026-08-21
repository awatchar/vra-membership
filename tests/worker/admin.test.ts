import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentInput, Repository } from '../../src/worker/db';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import {
  ACCESS_JWT_COOKIE,
  ACCESS_JWT_HEADER,
  resetAccessCertCache,
} from '../../src/worker/security/access';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../../src/worker/security/csrf';
import { createAuditLog } from '../../src/worker/services/audit';
import { createEmailService } from '../../src/worker/services/email';
import { createNbtcCompletion } from '../../src/worker/services/nbtc-completion';
import { createNumberingService } from '../../src/worker/services/numbering';
import { createReceiptService } from '../../src/worker/services/receipt';
import { createStateMachine } from '../../src/worker/services/state-machine';
import {
  createAccessKeyPair,
  createAccessToken,
  serveCerts,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from '../support/access';
import type { AccessKeyPair } from '../support/access';
import {
  FIVE_YEAR_SATANG,
  TEST_CITIZEN_ID,
  repository,
  seedApplication,
} from '../support/fixtures';

/**
 * Admin endpoints end to end, with **real** Cloudflare Access verification.
 *
 * The tests mint genuine RS256 tokens and serve a genuine JWKS, so the signature
 * check, the claim checks and the certificate fetch all run for real. Only the
 * network call to Cloudflare is intercepted. A mock verifier here would leave the
 * single control between the internet and the manager's data untested, which is
 * the opposite of what a high-risk change needs.
 */

const APPLICANT_EMAIL = 'applicant@example.test';
const MANAGER = 'manager@example.test';
const ORIGIN = 'http://localhost:8787';
const CSRF = 'a'.repeat(64);

let keys: AccessKeyPair;
let restoreFetch: () => void;

beforeEach(async () => {
  resetAccessCertCache();
  keys = await createAccessKeyPair();
  restoreFetch = serveCerts(keys);
});

afterEach(() => {
  restoreFetch();
});

interface CallOptions {
  method?: string;
  token?: string | null;
  /** Sends the token in the cookie instead of the header. */
  inCookie?: boolean;
  csrf?: { cookie?: string; header?: string } | null;
  origin?: string | null;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers();
  const cookies: string[] = [];

  const token = options.token === undefined ? await createAccessToken(keys) : options.token;
  if (token !== null) {
    if (options.inCookie) cookies.push(`${ACCESS_JWT_COOKIE}=${token}`);
    else headers.set(ACCESS_JWT_HEADER, token);
  }

  const method = options.method ?? 'GET';
  if (method !== 'GET') {
    const csrf = options.csrf === undefined ? { cookie: CSRF, header: CSRF } : options.csrf;
    if (csrf?.cookie) cookies.push(`${CSRF_COOKIE_NAME}=${csrf.cookie}`);
    if (csrf?.header) headers.set(CSRF_HEADER_NAME, csrf.header);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers.set('origin', origin);
  }

  if (cookies.length > 0) headers.set('cookie', cookies.join('; '));

  return exports.default.fetch(new Request(`http://localhost${path}`, { method, headers }));
}

function paymentInput(applicationId: string): PaymentInput {
  return {
    applicationId,
    provider: 'slipok',
    transactionRef: `TXN-${crypto.randomUUID()}`,
    amountSatang: FIVE_YEAR_SATANG,
    sendingBank: '002',
    receivingBank: 'ธนาคารตัวอย่าง',
    receiverAccountDigits: '1234',
    transactionAt: new Date().toISOString(),
    receiverMatched: true,
    amountMatched: true,
    verificationStatus: 'VERIFIED',
    verifiedAt: new Date().toISOString(),
  };
}

/** An application the manager has been notified about, which is the usual case. */
async function notifiedApplication(repo: Repository, citizenId?: string): Promise<string> {
  const id = await seedApplication(repo, citizenId);
  await repo.applications.updateContact(id, { email: APPLICANT_EMAIL, phone: '0800000000' });
  await repo.addresses.upsert(id, {
    idAddress: '99/9',
    idSubdistrict: 'ตำบลทดสอบ',
    idDistrict: 'อำเภอทดสอบ',
    idProvince: 'จังหวัดทดสอบ',
    mailSameAsId: true,
    mailRecipient: null,
    mailAddress: null,
    mailSubdistrict: null,
    mailDistrict: null,
    mailProvince: null,
    mailPostcode: null,
    mailPhone: null,
  });
  await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);
  await repo.applications.setReferenceNo(id, `VRA-2569-${crypto.randomUUID().slice(0, 6)}`);
  await repo.payments.create(paymentInput(id));

  const machine = createStateMachine(repo);
  await machine.transition(id, 'AWAITING_PAYMENT');
  await machine.transition(id, 'PAYMENT_VERIFIED');
  await machine.transition(id, 'SUBMITTED');
  await machine.transition(id, 'MANAGER_NOTIFIED');
  return id;
}

describe('Access authentication', () => {
  it('accepts a correctly signed token in the header', async () => {
    const repo = repository();
    await notifiedApplication(repo);

    const response = await call('/api/admin/applications');

    expect(response.status).toBe(200);
  });

  it('accepts the token in the CF_Authorization cookie', async () => {
    const response = await call('/api/admin/applications', { inCookie: true });

    expect(response.status).toBe(200);
  });

  it('refuses a request with no token', async () => {
    const response = await call('/api/admin/applications', { token: null });

    expect(response.status).toBe(403);
  });

  it('refuses a token signed by a different key', async () => {
    const other = await createAccessKeyPair('test-key-1');
    const forged = await createAccessToken(keys, { signWith: other });

    const response = await call('/api/admin/applications', { token: forged });

    expect(response.status).toBe(403);
  });

  it('refuses a token minted for another Access application', async () => {
    // Without the `aud` check any token from the same account would work here.
    const token = await createAccessToken(keys, { audience: ['some-other-application'] });

    const response = await call('/api/admin/applications', { token });

    expect(response.status).toBe(403);
  });

  it('refuses a token from another team', async () => {
    const token = await createAccessToken(keys, {
      issuer: 'https://someone-else.cloudflareaccess.com',
    });

    const response = await call('/api/admin/applications', { token });

    expect(response.status).toBe(403);
  });

  it('refuses an expired token', async () => {
    const token = await createAccessToken(keys, { expiresInSeconds: -3600 });

    const response = await call('/api/admin/applications', { token });

    expect(response.status).toBe(403);
  });

  it('refuses a token that is not valid yet', async () => {
    const token = await createAccessToken(keys, { notBeforeSeconds: 3600 });

    const response = await call('/api/admin/applications', { token });

    expect(response.status).toBe(403);
  });

  it('refuses an unsigned token', async () => {
    // `alg: none` with an empty signature is the classic JWT bypass. The
    // algorithm is fixed rather than read from the token for this reason.
    const token = await createAccessToken(keys, { algorithm: 'none' });

    const response = await call('/api/admin/applications', { token });

    expect(response.status).toBe(403);
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const token = await createAccessToken(keys);
    const [header, , signature] = token.split('.');
    const tampered = btoa(JSON.stringify({ aud: [TEST_AUDIENCE], iss: TEST_ISSUER, exp: 9e9 }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');

    const response = await call('/api/admin/applications', {
      token: `${header}.${tampered}.${signature}`,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a token with no subject', async () => {
    const token = await createAccessToken(keys, { subject: null });

    const response = await call('/api/admin/applications', { token });

    expect(response.status).toBe(403);
  });

  it('says nothing about which check refused it', async () => {
    const expired = await call('/api/admin/applications', {
      token: await createAccessToken(keys, { expiresInSeconds: -3600 }),
    });
    const wrongAudience = await call('/api/admin/applications', {
      token: await createAccessToken(keys, { audience: ['other'] }),
    });

    // Distinguishable failures would tell someone probing the endpoint which
    // part of their token to fix. The request id differs by design and is not
    // part of what the response says about the token.
    const first = await expired.json<{ error: { code: string; message: string } }>();
    const second = await wrongAudience.json<{ error: { code: string; message: string } }>();
    expect(expired.status).toBe(wrongAudience.status);
    expect(first.error.code).toBe(second.error.code);
    expect(first.error.message).toBe(second.error.message);
  });

  it('refuses everything when the certificate endpoint is unreachable', async () => {
    const token = await createAccessToken(keys);
    restoreFetch();
    resetAccessCertCache();
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('network down'));

    try {
      const response = await call('/api/admin/applications', { token });

      // Failing open here would make the admin API public during an outage.
      expect(response.status).toBe(403);
    } finally {
      globalThis.fetch = original;
      restoreFetch = serveCerts(keys);
    }
  });
});

describe('every admin endpoint requires Access', () => {
  const paths = [
    { method: 'GET', path: '/api/admin/session' },
    { method: 'GET', path: '/api/admin/applications' },
    { method: 'GET', path: `/api/admin/applications/${crypto.randomUUID()}` },
    { method: 'POST', path: `/api/admin/applications/${crypto.randomUUID()}/acknowledge` },
    { method: 'POST', path: `/api/admin/applications/${crypto.randomUUID()}/nbtc-complete` },
    { method: 'POST', path: `/api/admin/applications/${crypto.randomUUID()}/finalize` },
    { method: 'GET', path: `/api/admin/applications/${crypto.randomUUID()}/photo` },
    { method: 'GET', path: `/api/admin/applications/${crypto.randomUUID()}/receipt` },
    { method: 'GET', path: `/api/admin/applications/${crypto.randomUUID()}/citizen-id` },
  ];

  for (const route of paths) {
    it(`refuses ${route.method} ${route.path.replace(/[0-9a-f-]{36}/, ':id')} without a token`, async () => {
      const response = await call(route.path, { method: route.method, token: null });

      expect(response.status).toBe(403);
    });
  }
});

describe('CSRF on state changes', () => {
  it('refuses a POST with no origin header', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/acknowledge`, {
      method: 'POST',
      origin: null,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a POST from another origin', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    // Access authenticates with a cookie, and a cookie is sent cross-site too.
    const response = await call(`/api/admin/applications/${id}/acknowledge`, {
      method: 'POST',
      origin: 'https://attacker.example.test',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a POST with no CSRF token', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/acknowledge`, {
      method: 'POST',
      csrf: null,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a POST whose header and cookie tokens disagree', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/acknowledge`, {
      method: 'POST',
      csrf: { cookie: CSRF, header: 'b'.repeat(64) },
    });

    expect(response.status).toBe(403);
  });

  it('changes nothing when CSRF fails', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST', csrf: null });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'MANAGER_NOTIFIED',
    });
  });

  it('issues a token from the session endpoint', async () => {
    const response = await call('/api/admin/session');
    const body = await response.json<{
      manager: { email: string };
      csrf: { header: string; token: string };
    }>();

    expect(response.status).toBe(200);
    expect(body.manager.email).toBe(MANAGER);
    expect(body.csrf.header).toBe(CSRF_HEADER_NAME);
    expect(body.csrf.token).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get('set-cookie')).toContain(CSRF_COOKIE_NAME);
  });
});

describe('GET never changes state', () => {
  it('leaves the status untouched on every read', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    // An email security scanner opens links in messages. A GET that advanced
    // the application would let an anti-virus gateway act for the manager
    // (Issue #1 section 37).
    for (const path of [
      '/api/admin/applications',
      `/api/admin/applications/${id}`,
      `/api/admin/applications/${id}/receipt`,
      `/api/admin/applications/${id}/photo`,
      `/api/admin/applications/${id}/citizen-id`,
    ]) {
      await call(path);
    }

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'MANAGER_NOTIFIED',
    });
  });
});

describe('the application list', () => {
  it('returns applications without their personal details', async () => {
    const repo = repository();
    await notifiedApplication(repo);

    const response = await call('/api/admin/applications');
    const body = await response.json<{ applications: Record<string, unknown>[] }>();

    expect(body.applications).toHaveLength(1);
    const item = body.applications[0]!;
    expect(item['referenceNo']).toMatch(/^VRA-2569-/);
    // A queue view needs a name, not an address, a phone number or a card.
    const serialised = JSON.stringify(item);
    expect(serialised).not.toContain(TEST_CITIZEN_ID);
    expect(serialised).not.toContain(APPLICANT_EMAIL);
    expect(serialised).not.toContain('จังหวัดทดสอบ');
  });

  it('filters by status', async () => {
    const repo = repository();
    await notifiedApplication(repo, '1234567890121');
    const draft = await seedApplication(repo, '1234567890139');

    const notified = await call('/api/admin/applications?status=MANAGER_NOTIFIED');
    const drafts = await call('/api/admin/applications?status=DRAFT');

    const notifiedBody = await notified.json<{ applications: { id: string }[] }>();
    const draftBody = await drafts.json<{ applications: { id: string }[] }>();
    expect(notifiedBody.applications).toHaveLength(1);
    expect(draftBody.applications).toHaveLength(1);
    expect(draftBody.applications[0]!.id).toBe(draft);
  });

  it('rejects an unknown status rather than ignoring the filter', async () => {
    const response = await call('/api/admin/applications?status=NOT_A_STATUS');

    // Ignoring it would turn a typo into a full listing of personal data.
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the citizen ID', () => {
  it('is not part of the detail at all', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}`);
    const body = await response.text();

    // Opening the page must not decrypt. Otherwise every glance produces an
    // access event and the trail cannot tell a lookup from a page load.
    expect(response.status).toBe(200);
    expect(body).not.toContain(TEST_CITIZEN_ID);
    const events = await repo.events.listByApplicationId(id);
    expect(events.some((event) => event.eventType === 'CITIZEN_ID_ACCESSED')).toBe(false);
  });

  it('is returned on request, and the read is recorded', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/citizen-id`);
    const body = await response.json<{ citizenId: string }>();

    expect(response.status).toBe(200);
    expect(body.citizenId).toBe(TEST_CITIZEN_ID);

    const events = await repo.events.listByApplicationId(id);
    const access = events.find((event) => event.eventType === 'CITIZEN_ID_ACCESSED');
    expect(access?.actorType).toBe('MANAGER');
    expect(access?.actorId).toBe(MANAGER);
  });

  it('records one event per request, so the trail counts them', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    await call(`/api/admin/applications/${id}/citizen-id`);
    await call(`/api/admin/applications/${id}/citizen-id`);

    const events = await repo.events.listByApplicationId(id);
    expect(events.filter((event) => event.eventType === 'CITIZEN_ID_ACCESSED')).toHaveLength(2);
  });

  it('needs Access like everything else', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/citizen-id`, { token: null });

    expect(response.status).toBe(403);
  });
});

describe('the application detail', () => {
  it('includes what the manager needs to do the registration', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}`);
    const body = await response.json<{
      detail: {
        application: { email: string; phone: string; membershipLabel: string };
        address: { idProvince: string } | null;
        payment: { transactionRef: string } | null;
        workflow: { complete: boolean };
        events: unknown[];
      };
    }>();

    expect(body.detail.application.email).toBe(APPLICANT_EMAIL);
    expect(body.detail.application.membershipLabel).toBe('สมาชิกสามัญราย 5 ปี');
    expect(body.detail.address?.idProvince).toBe('จังหวัดทดสอบ');
    expect(body.detail.payment?.transactionRef).toMatch(/^TXN-/);
    expect(body.detail.events.length).toBeGreaterThan(0);
  });

  it('reports which post-payment steps stalled without retrying them', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}`);
    const body = await response.json<{ detail: { workflow: { steps: Record<string, string> } } }>();

    // No receipt was issued in this fixture, so the manager can see exactly
    // that - and loading the page must not have issued one.
    expect(body.detail.workflow.steps['RECEIPT']).toBe('SKIPPED');
    expect(await repo.receipts.findByApplicationId(id)).toBeNull();
  });

  it('returns 404 for an application that does not exist', async () => {
    const response = await call(`/api/admin/applications/${crypto.randomUUID()}`);

    expect(response.status).toBe(404);
  });
});

describe('acknowledge', () => {
  it('moves the application into processing and notifies the member once', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const first = await call(`/api/admin/applications/${id}/acknowledge`, { method: 'POST' });
    const second = await call(`/api/admin/applications/${id}/acknowledge`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(await first.json<{ processingEmailSent: boolean }>()).toMatchObject({
      processingEmailSent: true,
    });
    expect(await second.json<{ processingEmailSent: boolean }>()).toMatchObject({
      processingEmailSent: false,
    });
    expect(await repo.emails.findByApplicationIdAndType(id, 'MEMBER_PROCESSING')).toHaveLength(1);
    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      status: 'NBTC_PROCESSING',
    });
  });
});

describe('nbtc-complete', () => {
  async function acknowledged(repo: Repository): Promise<string> {
    const id = await notifiedApplication(repo);
    await call(`/api/admin/applications/${id}/acknowledge`, { method: 'POST' });
    return id;
  }

  it('records the registration, tells the member and completes the application', async () => {
    const repo = repository();
    const id = await acknowledged(repo);

    const response = await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });
    const body = await response.json<{ completion: Record<string, unknown> }>();

    expect(response.status).toBe(200);
    expect(body.completion).toMatchObject({
      recorded: 'DONE',
      completionEmail: 'DONE',
      completed: 'DONE',
      complete: true,
      status: 'COMPLETED',
    });
  });

  it('attributes the registration to the manager who confirmed it', async () => {
    const repo = repository();
    const id = await acknowledged(repo);

    await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });

    const application = await repo.applications.findById(id);
    expect(application?.nbtcRecordedBy).toBe(MANAGER);
    expect(application?.nbtcRecordedAt).not.toBeNull();

    const events = await repo.events.listByApplicationId(id);
    const confirmed = events.find((event) => event.eventType === 'MANAGER_CONFIRMED_NBTC_RECORD');
    expect(confirmed?.actorId).toBe(MANAGER);
  });

  it('records the documented trail for the second half of the process', async () => {
    const repo = repository();
    const id = await acknowledged(repo);

    await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });

    // Issue #1 section 50.
    const types = (await repo.events.listByApplicationId(id)).map((event) => event.eventType);
    const expected = [
      'MANAGER_ACKNOWLEDGED',
      'MEMBER_PROCESSING_EMAIL_SENT',
      'MANAGER_CONFIRMED_NBTC_RECORD',
      'MEMBER_COMPLETION_EMAIL_SENT',
    ];
    const positions = expected.map((event) => types.indexOf(event));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('is a no-op when called again, with no second email', async () => {
    const repo = repository();
    const id = await acknowledged(repo);
    await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });

    const response = await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });
    const body = await response.json<{ completion: Record<string, unknown> }>();

    expect(body.completion).toMatchObject({
      recorded: 'ALREADY_DONE',
      completionEmail: 'ALREADY_DONE',
      complete: true,
    });
    expect(await repo.emails.findByApplicationIdAndType(id, 'MEMBER_NBTC_COMPLETED')).toHaveLength(
      1,
    );
  });

  it('refuses an application that is not ready for it', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });
    const body = await response.json<{ completion: { recorded: string; status: string } }>();

    // `MANAGER_NOTIFIED` cannot jump to `NBTC_RECORDED`; the manager has to
    // acknowledge first, and the state machine refuses rather than inventing a
    // path.
    expect(body.completion.recorded).toBe('FAILED');
    expect(body.completion.status).toBe('MANAGER_NOTIFIED');
  });
});

describe('nbtc completion when the provider is down', () => {
  it('keeps the registration and does not claim completion', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);
    await call(`/api/admin/applications/${id}/acknowledge`, { method: 'POST' });

    const audit = createAuditLog(repo);
    const failing = createNbtcCompletion(
      repo,
      createStateMachine(repo),
      createEmailService(
        repo,
        createMockEmailProvider({ failWith: 'PROVIDER_ERROR' }),
        createReceiptService(repo, createNumberingService(repo), audit),
        audit,
        { managerEmail: MANAGER, appBaseUrl: ORIGIN },
      ),
    );

    const report = await failing.confirm(id, MANAGER);

    // The registration really happened; only the notice failed.
    expect(report.recorded).toBe('DONE');
    expect(report.completionEmail).toBe('FAILED');
    expect(report.completed).toBe('SKIPPED');
    expect(report.status).toBe('NBTC_RECORDED');
    expect(report.complete).toBe(false);
  });

  it('finishes when the provider comes back, without a second record', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);
    await call(`/api/admin/applications/${id}/acknowledge`, { method: 'POST' });
    const audit = createAuditLog(repo);
    const receipts = createReceiptService(repo, createNumberingService(repo), audit);

    await createNbtcCompletion(
      repo,
      createStateMachine(repo),
      createEmailService(
        repo,
        createMockEmailProvider({ failWith: 'PROVIDER_ERROR' }),
        receipts,
        audit,
        { managerEmail: MANAGER, appBaseUrl: ORIGIN },
      ),
    ).confirm(id, MANAGER);
    const recordedAt = (await repo.applications.findById(id))?.nbtcRecordedAt;

    const report = await call(`/api/admin/applications/${id}/nbtc-complete`, { method: 'POST' });
    const body = await report.json<{ completion: Record<string, unknown> }>();

    expect(body.completion).toMatchObject({
      recorded: 'ALREADY_DONE',
      completionEmail: 'DONE',
      completed: 'DONE',
      status: 'COMPLETED',
    });
    expect((await repo.applications.findById(id))?.nbtcRecordedAt).toBe(recordedAt);
    expect(await repo.emails.findByApplicationIdAndType(id, 'MEMBER_NBTC_COMPLETED')).toHaveLength(
      1,
    );
  });
});

describe('the member photo', () => {
  it('is served through the authenticated endpoint', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);
    const key = `member-photos/${crypto.randomUUID()}.jpg`;
    await env.MEMBER_PHOTOS.put(key, new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await repo.applications.setPhoto(id, { key, source: 'UPLOAD' });

    const response = await call(`/api/admin/applications/${id}/photo`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(4);
  });

  it('reports a missing photo rather than an empty body', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/photo`);

    expect(response.status).toBe(404);
  });
});

describe('the receipt', () => {
  it('is regenerated and its download recorded', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);
    const audit = createAuditLog(repo);
    const { receipt } = await createReceiptService(repo, createNumberingService(repo), audit).issue(
      id,
    );

    const response = await call(`/api/admin/applications/${id}/receipt`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain(`${receipt.receiptNo}.pdf`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');

    const events = await repo.events.listByApplicationId(id);
    const download = events.find((event) => event.eventType === 'RECEIPT_DOWNLOADED');
    expect(download?.actorId).toBe(MANAGER);
  });

  it('reports a missing receipt', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);

    const response = await call(`/api/admin/applications/${id}/receipt`);

    expect(response.status).toBe(404);
  });
});

describe('admin finalize', () => {
  it('finishes a stalled post-payment flow without the applicant', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    await repo.applications.updateContact(id, { email: APPLICANT_EMAIL });
    await repo.applications.setMembership(id, 'FIVE_YEAR', FIVE_YEAR_SATANG);
    await repo.payments.create(paymentInput(id));
    const machine = createStateMachine(repo);
    await machine.transition(id, 'AWAITING_PAYMENT');
    await machine.transition(id, 'PAYMENT_VERIFIED');

    const response = await call(`/api/admin/applications/${id}/finalize`, { method: 'POST' });
    const body = await response.json<{ confirmation: { complete: boolean; status: string } }>();

    expect(response.status).toBe(200);
    expect(body.confirmation.complete).toBe(true);
    expect(body.confirmation.status).toBe('MANAGER_NOTIFIED');
  });
});

describe('logging', () => {
  it('never logs the manager identity or applicant details', async () => {
    const repo = repository();
    const id = await notifiedApplication(repo);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      await call(`/api/admin/applications/${id}`);
      await call(`/api/admin/applications/${id}/acknowledge`, { method: 'POST' });
    } finally {
      console.log = original;
    }

    const output = lines.join('\n');
    expect(output).not.toContain(MANAGER);
    expect(output).not.toContain(APPLICANT_EMAIL);
    expect(output).not.toContain(TEST_CITIZEN_ID);
    expect(output).not.toContain('ทดสอบ');
  });
});
