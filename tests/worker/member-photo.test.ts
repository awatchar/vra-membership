import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createAuditLog } from '../../src/worker/services/audit';
import { createMemberPhotoService } from '../../src/worker/services/member-photo';
import { createStateMachine } from '../../src/worker/services/state-machine';
import { TURNSTILE_TOKEN_HEADER } from '../../src/worker/security/turnstile';
import { makeMemberPhoto, makePng } from '../support/images';
import {
  OTHER_TEST_CITIZEN_ID,
  repository,
  seedApplication,
  TEST_CITIZEN_ID,
} from '../support/fixtures';

const GPS_MARKER = 'GPSLatitude=13.7563';

function service(repo = repository()) {
  return createMemberPhotoService(repo, env.MEMBER_PHOTOS, createAuditLog(repo));
}

async function objectKeys(): Promise<string[]> {
  const listing = await env.MEMBER_PHOTOS.list();
  return listing.objects.map((object) => object.key).sort();
}

async function objectText(key: string): Promise<string> {
  const object = await env.MEMBER_PHOTOS.get(key);
  const bytes = new Uint8Array(await object!.arrayBuffer());
  return new TextDecoder('latin1').decode(bytes);
}

describe('storing a member photo', () => {
  it('stores the photo and records it on the application', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const stored = await service(repo).store({
      applicationId: id,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    expect(stored.width).toBe(600);
    expect(stored.height).toBe(800);
    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      photoKey: stored.key,
      photoSource: 'UPLOAD',
    });
    await expect(objectKeys()).resolves.toEqual([stored.key]);
  });

  it('uses a random key that reveals nothing about the applicant', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const stored = await service(repo).store({
      applicationId: id,
      source: 'ID_CARD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    // A bucket listing must not be a membership roster (Issue #1 section 13).
    expect(stored.key).toMatch(/^member-photos\/[0-9a-f-]{36}\.jpg$/);
    expect(stored.key).not.toContain(TEST_CITIZEN_ID);
    expect(stored.key).not.toContain('ทดสอบ');
    expect(stored.key).not.toContain(id);
  });

  it('strips EXIF before the bytes reach the bucket', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const stored = await service(repo).store({
      applicationId: id,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto({ withExif: true }),
      contentType: 'image/jpeg',
    });

    expect(stored.metadataStripped).toBe(true);
    // Read it back out of R2: the guarantee is about what is stored, not about
    // what the function returned.
    await expect(objectText(stored.key)).resolves.not.toContain(GPS_MARKER);
  });

  it('stores no R2 custom metadata', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stored = await service(repo).store({
      applicationId: id,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    const object = await env.MEMBER_PHOTOS.get(stored.key);
    // Object metadata is another place personal data could accumulate.
    expect(object!.customMetadata ?? {}).toEqual({});
    expect(object!.httpMetadata?.contentType).toBe('image/jpeg');
  });

  it('deletes the previous object when the photo is replaced', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const photos = service(repo);

    const first = await photos.store({
      applicationId: id,
      source: 'ID_CARD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });
    const second = await photos.store({
      applicationId: id,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto({ width: 900, height: 1200 }),
      contentType: 'image/jpeg',
    });

    expect(second.replacedPrevious).toBe(true);
    // Without this, every retake leaves an orphaned face that nothing
    // references and nobody will ever delete.
    await expect(objectKeys()).resolves.toEqual([second.key]);
    await expect(env.MEMBER_PHOTOS.get(first.key)).resolves.toBeNull();
  });

  it('reports the source change on a replacement', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const photos = service(repo);

    await photos.store({
      applicationId: id,
      source: 'ID_CARD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });
    await photos.store({
      applicationId: id,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    await expect(repo.applications.findById(id)).resolves.toMatchObject({
      photoSource: 'UPLOAD',
    });
  });

  it('keeps one photo per applicant even across several applications', async () => {
    const repo = repository();
    const mine = await seedApplication(repo, TEST_CITIZEN_ID);
    const other = await seedApplication(repo, OTHER_TEST_CITIZEN_ID);
    const photos = service(repo);

    await photos.store({
      applicationId: mine,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });
    await photos.store({
      applicationId: other,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    await expect(objectKeys()).resolves.toHaveLength(2);
  });
});

describe('consent and eligibility', () => {
  it('refuses to store without an explicit confirmation', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    // Using the face from the ID card without the applicant saying so is
    // exactly what Issue #1 section 61 forbids.
    await expect(
      service(repo).store({
        applicationId: id,
        source: 'ID_CARD',
        confirmed: false,
        bytes: makeMemberPhoto(),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow(/ยืนยันการเลือกรูป/);

    await expect(objectKeys()).resolves.toEqual([]);
  });

  it('refuses an unknown application', async () => {
    await expect(
      service().store({
        applicationId: crypto.randomUUID(),
        source: 'UPLOAD',
        confirmed: true,
        bytes: makeMemberPhoto(),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow();

    await expect(objectKeys()).resolves.toEqual([]);
  });

  it('refuses once the application has moved past the editable states', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const machine = createStateMachine(repo);
    for (const status of [
      'AWAITING_PAYMENT',
      'PAYMENT_VERIFIED',
      'SUBMITTED',
      'MANAGER_NOTIFIED',
    ] as const) {
      await machine.transition(id, status);
    }

    // The photo may already be on a printed card by now, so changing it
    // silently would leave the card and the record disagreeing.
    await expect(
      service(repo).store({
        applicationId: id,
        source: 'UPLOAD',
        confirmed: true,
        bytes: makeMemberPhoto(),
        contentType: 'image/jpeg',
      }),
    ).rejects.toThrow();
  });

  it('records a PHOTO_SELECTED audit event carrying only the source', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const stored = await service(repo).store({
      applicationId: id,
      source: 'ID_CARD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    const events = await repo.events.listByApplicationId(id);
    const selected = events.find((event) => event.eventType === 'PHOTO_SELECTED');
    expect(selected).toMatchObject({ actorType: 'APPLICANT', metadata: { source: 'ID_CARD' } });
    // The key is the one string that points straight at a stored face.
    expect(JSON.stringify(events)).not.toContain(stored.key);
  });
});

describe('reading a stored photo', () => {
  it('returns the stored bytes', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const photos = service(repo);
    await photos.store({
      applicationId: id,
      source: 'UPLOAD',
      confirmed: true,
      bytes: makeMemberPhoto(),
      contentType: 'image/jpeg',
    });

    const read = await photos.read(id);
    expect(read?.contentType).toBe('image/jpeg');
  });

  it('returns null when the application has no photo', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    await expect(service(repo).read(id)).resolves.toBeNull();
  });

  it('returns null for an unknown application', async () => {
    await expect(service().read(crypto.randomUUID())).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------- endpoint --- */

function photoForm(
  applicationId: string,
  overrides: { source?: string; confirmed?: string; bytes?: Uint8Array; omitFile?: boolean } = {},
): FormData {
  const form = new FormData();
  form.append('applicationId', applicationId);
  form.append('source', overrides.source ?? 'UPLOAD');
  form.append('confirmed', overrides.confirmed ?? 'true');
  if (!overrides.omitFile) {
    const bytes = overrides.bytes ?? makeMemberPhoto();
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
  }
  return form;
}

function photoRequest(form: FormData, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/member-photo', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '203.0.113.30',
      [TURNSTILE_TOKEN_HEADER]: 'test-token',
      ...headers,
    },
    body: form,
  });
}

describe('POST /api/member-photo', () => {
  it('stores the photo and reports the shape without leaking the key', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(photoRequest(photoForm(id)));

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ stored: true, source: 'UPLOAD', width: 600, height: 800 });
    // The client has no use for the key, and it points directly at a face.
    expect(JSON.stringify(body)).not.toContain('member-photos/');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a request with no Turnstile token', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(
      photoRequest(photoForm(id), { [TURNSTILE_TOKEN_HEADER]: '' }),
    );

    expect(response.status).toBe(403);
    await expect(objectKeys()).resolves.toEqual([]);
  });

  it('refuses when the confirmation is absent', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(
      photoRequest(photoForm(id, { confirmed: 'false' })),
    );

    expect(response.status).toBe(422);
    await expect(objectKeys()).resolves.toEqual([]);
  });

  it('refuses an unknown photo source', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(
      photoRequest(photoForm(id, { source: 'SCANNED' })),
    );

    expect(response.status).toBe(422);
  });

  it('refuses a file that is not really an image', async () => {
    const repo = repository();
    const id = await seedApplication(repo);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

    const response = await exports.default.fetch(photoRequest(photoForm(id, { bytes: pdf })));

    expect(response.status).toBe(415);
    await expect(objectKeys()).resolves.toEqual([]);
  });

  it('refuses a PNG, because its metadata is not rewritten', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(
      photoRequest(photoForm(id, { bytes: makePng(600, 800) })),
    );

    expect(response.status).toBe(415);
  });

  it('stores a full square photo without requiring a 3:4 crop', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(
      photoRequest(photoForm(id, { bytes: makeMemberPhoto({ width: 800, height: 800 }) })),
    );

    expect(response.status).toBe(200);
    await expect(objectKeys()).resolves.toHaveLength(1);
  });

  it('refuses a request with no file', async () => {
    const repo = repository();
    const id = await seedApplication(repo);

    const response = await exports.default.fetch(photoRequest(photoForm(id, { omitFile: true })));

    expect(response.status).toBe(400);
  });

  it('refuses an application id that is not a uuid', async () => {
    const response = await exports.default.fetch(photoRequest(photoForm('not-a-uuid')));

    expect(response.status).toBe(422);
  });

  it('reports a missing application as not found', async () => {
    const response = await exports.default.fetch(photoRequest(photoForm(crypto.randomUUID())));

    expect(response.status).toBe(404);
  });
});
