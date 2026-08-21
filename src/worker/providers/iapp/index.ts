import type {
  ImagePayload,
  OcrFailureReason,
  OcrProvider,
  OcrResult,
  ThaiIdCardData,
} from '../types';
import { parseIappEnglishDate } from './dates';

/**
 * iApp Thai National ID Card OCR adapter.
 *
 * Contract (public documentation, August 2026):
 *   POST https://api.iapp.co.th/v3/store/ekyc/thai-national-id-card/front
 *   header `apikey`, multipart body field `file`
 *
 * Two things about this adapter matter more than the mapping itself.
 *
 * **The card image is never persisted.** It arrives as bytes, goes into one
 * `fetch`, and is dropped when the request ends. Nothing here writes to R2, to
 * D1 or to a log (Issue #1 section 6).
 *
 * **The response is narrowed, not passed through.** iApp returns religion,
 * gender, issue date, confidence scores, bounding boxes and a postal code. Only
 * the fields the membership process needs are mapped, so data with no business
 * purpose cannot reach the database even if a caller asks for it
 * (Issue #1 section 8).
 *
 * The postal code deserves its own note: a Thai ID card does not print one, so
 * whatever iApp returns there is inferred from the district. Issue #1 section
 * 9.1 forbids deriving a postcode from OCR, and the applicant enters it
 * themselves. It is therefore deliberately not mapped.
 */

const FRONT_ENDPOINT = 'https://api.iapp.co.th/v3/store/ekyc/thai-national-id-card/front';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Gives the multipart part a neutral filename whose extension agrees with the
 * validated content type. The original client filename is deliberately not
 * available at this boundary: it may contain personal information, while some
 * provider upload pipelines still use the extension to select an image
 * decoder even when the part also has a Content-Type header.
 */
function multipartFilename(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'front.jpg';
    case 'image/png':
      return 'front.png';
    case 'image/webp':
      return 'front.webp';
    default:
      // The OCR route rejects unsupported magic bytes before this adapter is
      // called. Keep an explicit non-image fallback so a future caller cannot
      // make arbitrary bytes look like a JPEG merely through its filename.
      return 'front.bin';
  }
}

/**
 * Maps iApp HTTP status codes onto internal failure reasons.
 *
 * Anything unlisted becomes `PROVIDER_ERROR`, so a new code from the provider
 * degrades to a generic failure rather than being reported as something it is
 * not.
 */
const FAILURE_BY_STATUS: Readonly<Record<number, OcrFailureReason>> = {
  // The image is not an ID card at all.
  420: 'NOT_A_THAI_ID_CARD',
  // Format unsupported, damaged, wrong dimensions, or greyscale.
  421: 'PROVIDER_REJECTED_IMAGE',
  422: 'PROVIDER_REJECTED_IMAGE',
  426: 'PROVIDER_REJECTED_IMAGE',
  413: 'PROVIDER_REJECTED_IMAGE',
  461: 'PROVIDER_REJECTED_IMAGE',
  // The card was found but the number could not be read or does not check out.
  424: 'UNREADABLE',
  425: 'UNREADABLE',
  // Server-side or queue timeout.
  427: 'PROVIDER_TIMEOUT',
  428: 'PROVIDER_TIMEOUT',
};

/** Shape of the fields this adapter reads. Everything else is ignored. */
interface IappFrontResponse {
  id_number?: unknown;
  th_init?: unknown;
  th_fname?: unknown;
  th_lname?: unknown;
  en_fname?: unknown;
  en_lname?: unknown;
  en_dob?: unknown;
  en_expire?: unknown;
  address?: unknown;
  sub_district?: unknown;
  district?: unknown;
  province?: unknown;
  face?: unknown;
}

/** Trimmed string, or null for anything absent or blank. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Digits only. OCR sometimes returns the number with the card's spacing. */
function citizenId(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Decodes the cropped face photo.
 *
 * iApp returns raw base64 rather than a data URI. A `data:` prefix is tolerated
 * anyway, because silently producing a corrupt image if the provider changes
 * that would be worse than a two-line guard.
 */
function faceImage(value: unknown): ImagePayload | null {
  const raw = text(value);
  if (raw === null) return null;

  const base64 = raw.startsWith('data:') ? (raw.split(',')[1] ?? '') : raw;
  const bytes = decodeBase64(base64);
  return bytes ? { bytes, contentType: 'image/jpeg' } : null;
}

/**
 * Narrows an iApp response to the internal model.
 *
 * Exported so a test can assert on the mapping without an HTTP round trip, and
 * so the set of fields that survives is visible in one place.
 */
export function mapIappFrontResponse(payload: unknown): ThaiIdCardData | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const response = payload as IappFrontResponse;

  const id = citizenId(response.id_number);
  if (id === null) return null;

  return {
    citizenId: id,
    titleTh: text(response.th_init),
    firstNameTh: text(response.th_fname),
    lastNameTh: text(response.th_lname),
    firstNameEn: text(response.en_fname),
    lastNameEn: text(response.en_lname),
    // The English forms are Gregorian already; the Thai ones are Buddhist and
    // would need a calendar conversion that could be off by a year.
    birthDate: parseIappEnglishDate(response.en_dob),
    cardExpiryDate: parseIappEnglishDate(response.en_expire),
    addressLine: text(response.address),
    subdistrict: text(response.sub_district),
    district: text(response.district),
    province: text(response.province),
    faceImage: faceImage(response.face),
  };
}

export interface IappOcrOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}

export function createIappOcrProvider(options: IappOcrOptions): OcrProvider {
  const endpoint = options.endpoint ?? FRONT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    name: 'iapp-ocr',

    async readThaiIdCardFront(image: ImagePayload, signal?: AbortSignal): Promise<OcrResult> {
      const body = new FormData();
      // `get_bbox`, `get_image` and `get_original` are all left off: bounding
      // boxes and extra crops are data with no purpose here, and asking for
      // less is one fewer thing that could be stored by accident.
      body.append(
        'file',
        new Blob([image.bytes], { type: image.contentType }),
        multipartFilename(image.contentType),
      );

      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { apikey: options.apiKey },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        // A timeout and a network failure are reported differently because the
        // applicant-facing advice differs: wait and retry, versus check the
        // connection.
        const aborted = error instanceof Error && error.name === 'TimeoutError';
        return { ok: false, reason: aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR' };
      }

      if (!response.ok) {
        return { ok: false, reason: FAILURE_BY_STATUS[response.status] ?? 'PROVIDER_ERROR' };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: 'PROVIDER_ERROR' };
      }

      const data = mapIappFrontResponse(payload);
      if (data === null) {
        // A 200 with no usable card number means the image was not a card, or
        // was too poor to read. Either way the applicant should retake it.
        return { ok: false, reason: 'UNREADABLE' };
      }

      return { ok: true, data };
    },
  };
}
