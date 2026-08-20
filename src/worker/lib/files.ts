import { ApiError } from './http';

/**
 * Upload validation for the three images the workflow touches: the ID card
 * (never stored), the member photo (stored) and the payment slip (never
 * stored) - Issue #1 section 59.
 *
 * Two rules drive the design:
 *
 * 1. **The declared content type is a hint, not evidence.** `Content-Type` and
 *    a file's name come from the client, so the type is decided by sniffing the
 *    leading bytes. A PDF or a script renamed to `.jpg` must not reach a
 *    provider or the bucket.
 * 2. **The size limit is enforced while reading, not after.** Buffering an
 *    arbitrary upload and then measuring it is how a Worker gets killed by a
 *    single request. The stream is read with a running total and abandoned the
 *    moment it goes over.
 */

export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Applicant-safe Thai messages; these reach the browser. */
const MESSAGES = {
  tooLarge: 'ไฟล์มีขนาดใหญ่เกินกำหนด กรุณาถ่ายภาพใหม่หรือย่อขนาดไฟล์',
  unsupported: 'รองรับเฉพาะไฟล์ภาพ JPEG, PNG หรือ WebP เท่านั้น',
  empty: 'ไม่พบไฟล์ภาพ กรุณาเลือกไฟล์อีกครั้ง',
} as const;

interface Signature {
  type: SupportedImageType;
  /** Byte values to match, with `null` for a position that may be anything. */
  bytes: readonly (number | null)[];
  offset: number;
}

/**
 * Magic-byte signatures. WebP needs two checks because `RIFF` alone is a
 * container that also holds AVI and WAV.
 */
const SIGNATURES: readonly Signature[] = [
  { type: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    type: 'image/png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // "RIFF" .... "WEBP"
  { type: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
];

const WEBP_FORM_TYPE = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8

function matches(bytes: Uint8Array, signature: Signature): boolean {
  if (bytes.byteLength < signature.offset + signature.bytes.length) return false;
  return signature.bytes.every((expected, index) => {
    if (expected === null) return true;
    return bytes[signature.offset + index] === expected;
  });
}

/** Returns the sniffed type, or null when the bytes are not a supported image. */
export function sniffImageType(bytes: Uint8Array): SupportedImageType | null {
  for (const signature of SIGNATURES) {
    if (!matches(bytes, signature)) continue;
    if (signature.type !== 'image/webp') return signature.type;

    const isWebp = WEBP_FORM_TYPE.every((expected, index) => bytes[8 + index] === expected);
    if (isWebp) return 'image/webp';
  }
  return null;
}

export interface ImageValidationOptions {
  maxBytes: number;
  /** Defaults to every supported type. */
  allowedTypes?: readonly SupportedImageType[];
}

export interface ValidatedImage {
  bytes: Uint8Array;
  /** The sniffed type, never the declared one. */
  contentType: SupportedImageType;
}

/**
 * Reads at most `maxBytes + 1` bytes from `stream`.
 *
 * Reading one byte past the limit is what makes "too large" detectable without
 * ever holding more than the limit plus a byte in memory.
 */
async function readWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      chunks.push(value);

      if (total > maxBytes) {
        return { bytes: new Uint8Array(0), exceeded: true };
      }
    }
  } finally {
    // Release the lock even when abandoning early, so the request can be
    // discarded without leaving the body half-read.
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded: false };
}

/**
 * Validates an image already held in memory, e.g. one field of a parsed form.
 * Throws `ApiError` with an applicant-safe message.
 */
export function validateImageBytes(
  bytes: Uint8Array,
  options: ImageValidationOptions,
): ValidatedImage {
  if (bytes.byteLength === 0) {
    throw new ApiError('BAD_REQUEST', MESSAGES.empty);
  }
  if (bytes.byteLength > options.maxBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
  }

  const contentType = sniffImageType(bytes);
  const allowed = options.allowedTypes ?? SUPPORTED_IMAGE_TYPES;
  if (contentType === null || !allowed.includes(contentType)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', MESSAGES.unsupported);
  }

  return { bytes, contentType };
}

/**
 * Reads and validates an image from a request body stream.
 *
 * The `Content-Length` header is checked first purely to fail fast; it is
 * client-supplied, so the byte count from the stream is the one that decides.
 */
export async function readValidatedImage(
  request: Request,
  options: ImageValidationOptions,
): Promise<ValidatedImage> {
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
  }

  const body: ReadableStream<Uint8Array> | null = request.body;
  if (!body) {
    throw new ApiError('BAD_REQUEST', MESSAGES.empty);
  }

  const { bytes, exceeded } = await readWithLimit(body, options.maxBytes);
  if (exceeded) {
    throw new ApiError('PAYLOAD_TOO_LARGE', MESSAGES.tooLarge);
  }

  return validateImageBytes(bytes, options);
}
