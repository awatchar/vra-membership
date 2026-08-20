import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../context';
import { PHOTO_SOURCES } from '../db';
import { validateImageBytes } from '../lib/files';
import { ApiError } from '../lib/http';
import { assertWithinRateLimit, clientIdentifier, PHOTO_POLICY } from '../security/rate-limit';
import { assertHumanRequest } from '../security/turnstile';
import { parseWithSchema } from '../security/validation';
import { createAuditLog } from '../services/audit';
import { createMemberPhotoService } from '../services/member-photo';

/**
 * `POST /api/member-photo` - stores the photo the applicant chose for their card.
 *
 * Sent as multipart so the image and the choice that goes with it arrive
 * together: which source it came from, and the explicit confirmation that this
 * is the photo they want. Issue #1 section 61 requires that choice to be
 * deliberate, so it is a required field rather than a default.
 */

/** Generous enough for a 2400x3200 JPEG, small enough to bound memory. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const metadataSchema = z
  .object({
    applicationId: z.string().uuid(),
    source: z.enum(PHOTO_SOURCES),
    // Sent as a string because multipart has no booleans.
    confirmed: z.literal('true'),
  })
  .strict();

const MESSAGES = {
  form: 'ข้อมูลที่ส่งมาไม่ครบ กรุณาลองอีกครั้ง',
  missingFile: 'ไม่พบไฟล์รูป กรุณาเลือกรูปอีกครั้ง',
  tooLarge: 'ไฟล์รูปมีขนาดใหญ่เกินกำหนด กรุณาย่อขนาดรูป',
} as const;

export const memberPhotoRoutes = new Hono<AppContext>().post('/member-photo', async (c) => {
  await assertHumanRequest(c.var.security.turnstile, c.req.raw);
  await assertWithinRateLimit(
    c.var.security.rateLimiter,
    PHOTO_POLICY,
    clientIdentifier(c.req.raw),
  );

  const declaredLength = Number(c.req.header('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    // The parser error can quote the payload, so it is discarded.
    throw new ApiError('BAD_REQUEST', MESSAGES.form);
  }

  const metadata = parseWithSchema(metadataSchema, {
    applicationId: form.get('applicationId'),
    source: form.get('source'),
    confirmed: form.get('confirmed'),
  });

  const file = form.get('photo');
  if (!(file instanceof File)) {
    throw new ApiError('BAD_REQUEST', MESSAGES.missingFile);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
  }

  // The type is decided by the bytes, never by what the form claimed.
  const image = validateImageBytes(new Uint8Array(await file.arrayBuffer()), {
    maxBytes: MAX_UPLOAD_BYTES,
  });

  const service = createMemberPhotoService(c.var.db, c.env.MEMBER_PHOTOS, createAuditLog(c.var.db));

  const stored = await service.store({
    applicationId: metadata.applicationId,
    source: metadata.source,
    confirmed: metadata.confirmed === 'true',
    bytes: image.bytes,
    contentType: image.contentType,
  });

  c.var.logger.info({
    event: 'member_photo.stored',
    applicationId: metadata.applicationId,
    source: stored.source,
    count: stored.byteLength,
  });

  // The key is never returned. The client has no use for it, and it is the one
  // string that points directly at a stored face.
  c.header('Cache-Control', 'no-store');
  return c.json({
    stored: true,
    source: stored.source,
    width: stored.width,
    height: stored.height,
    metadataStripped: stored.metadataStripped,
    replacedPrevious: stored.replacedPrevious,
  });
});
