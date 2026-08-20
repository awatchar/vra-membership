import { Hono } from 'hono';
import type { AppContext } from '../context';
import { ApiError } from '../lib/http';
import { readValidatedImage } from '../lib/files';
import { assertWithinRateLimit, clientIdentifier, OCR_POLICY } from '../security/rate-limit';
import { assertHumanRequest } from '../security/turnstile';
import type { OcrFailureReason, ThaiIdCardData } from '../providers';

/**
 * `POST /api/ocr` - reads the front of a Thai national ID card.
 *
 * The card image lives in this request and nowhere else. It is read from the
 * body, validated, handed to the provider, and dropped when the handler
 * returns. No branch writes it to R2, to D1 or to a log (Issue #1 section 6).
 *
 * Order of operations is deliberate: Turnstile and the rate limit both run
 * before the body is read, so an abusive caller costs a header check rather
 * than a multi-megabyte upload and a paid OCR call.
 *
 * The result is a pre-fill. The applicant reviews and corrects it before
 * anything is stored (Issue #1 section 7), which is why an unparseable date
 * comes back as null instead of failing the request.
 */

/** A phone photo of a card, after the client has downscaled it. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Applicant-facing messages, one per failure reason.
 *
 * Each says what to do next, because "OCR failed" leaves the applicant stuck.
 * None of them expose the provider's own error text (Issue #1 section 65).
 */
const FAILURE_MESSAGES: Readonly<Record<OcrFailureReason, string>> = {
  UNREADABLE:
    'อ่านข้อมูลจากบัตรไม่สำเร็จ กรุณาถ่ายใหม่ให้เห็นบัตรเต็มใบในที่แสงสว่างเพียงพอ หรือกรอกข้อมูลด้วยตนเอง',
  NOT_A_THAI_ID_CARD:
    'ไม่พบบัตรประชาชนในภาพ กรุณาถ่ายด้านหน้าของบัตรประชาชนให้เห็นเต็มใบ หรือกรอกข้อมูลด้วยตนเอง',
  PROVIDER_REJECTED_IMAGE:
    'ไฟล์ภาพนี้ใช้อ่านข้อมูลไม่ได้ กรุณาถ่ายใหม่เป็นภาพสีที่ชัดเจน หรือกรอกข้อมูลด้วยตนเอง',
  PROVIDER_TIMEOUT: 'ระบบอ่านบัตรใช้เวลานานเกินไป กรุณาลองอีกครั้ง หรือกรอกข้อมูลด้วยตนเอง',
  PROVIDER_ERROR:
    'ไม่สามารถเชื่อมต่อระบบอ่านบัตรได้ในขณะนี้ กรุณาลองอีกครั้ง หรือกรอกข้อมูลด้วยตนเอง',
};

/**
 * Thrown when OCR does not produce usable data.
 *
 * Carries the reason separately from the message so the client can decide
 * between offering "retake" and offering "enter manually", which is the
 * fallback Issue #1 section 64 requires.
 */
export class OcrFailedError extends ApiError {
  readonly reason: OcrFailureReason;

  constructor(reason: OcrFailureReason) {
    super('OCR_FAILED', FAILURE_MESSAGES[reason]);
    this.name = 'OcrFailedError';
    this.reason = reason;
  }
}

/** Wire shape of the OCR result. The face image is base64 for the browser. */
export interface OcrResponseBody {
  data: Omit<ThaiIdCardData, 'faceImage'> & {
    /**
     * Cropped face photo, offered as a candidate for the member photo. Not
     * stored anywhere yet: the applicant has to choose it explicitly first
     * (Issue #1 section 61), which `POST /api/member-photo` handles.
     */
    faceImage: { contentType: string; base64: string } | null;
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const ocrRoutes = new Hono<AppContext>().post('/ocr', async (c) => {
  // Both checks run before the body is touched, so rejecting a request is cheap.
  await assertHumanRequest(c.var.security.turnstile, c.req.raw);
  await assertWithinRateLimit(c.var.security.rateLimiter, OCR_POLICY, clientIdentifier(c.req.raw));

  const image = await readValidatedImage(c.req.raw, { maxBytes: MAX_IMAGE_BYTES });

  const startedAt = Date.now();
  const result = await c.var.providers.ocr.readThaiIdCardFront(image);
  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    // The reason is an enum value, not provider text, so it is safe to log.
    c.var.logger.warn({
      event: 'ocr.failed',
      provider: c.var.providers.ocr.name,
      reason: result.reason,
      durationMs,
    });
    throw new OcrFailedError(result.reason);
  }

  // Field names only. Logging any value here would be logging the card.
  c.var.logger.info({
    event: 'ocr.completed',
    provider: c.var.providers.ocr.name,
    durationMs,
  });

  const { faceImage, ...fields } = result.data;
  const body: OcrResponseBody = {
    data: {
      ...fields,
      faceImage: faceImage
        ? { contentType: faceImage.contentType, base64: toBase64(faceImage.bytes) }
        : null,
    },
  };

  // The response contains personal data, so it must not be stored by a browser
  // or an intermediary.
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});
