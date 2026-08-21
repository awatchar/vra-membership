import { ApiError } from './http';
import type { SupportedImageType } from './files';

/**
 * Image inspection for the stored member photo.
 *
 * A Worker has no canvas and no image decoder, and adding a WASM one would cost
 * bundle size and CPU on every upload for a service handling one or two
 * applications a day. So the split is: the browser proportionally downsizes
 * and re-encodes large uploads, while the Worker verifies the full selected
 * frame rather than trusting it (owner decision #52).
 *
 * Verification reads the pixel dimensions straight out of the container header,
 * which needs no decoder, and strips the metadata segments that carry the data
 * nobody asked to share.
 *
 * The EXIF strip is the part that matters most. A photo taken on a phone can
 * carry GPS coordinates, the device serial and the capture timestamp. A canvas
 * re-encode drops all of that, but the Worker must not assume the client did it
 * - the client is where an attacker sits.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

const MESSAGES = {
  undecodable: 'ไม่สามารถอ่านขนาดของภาพได้ กรุณาเลือกภาพใหม่',
  tooSmall: 'ภาพมีความละเอียดต่ำเกินไปสำหรับใช้ทำบัตรสมาชิก กรุณาใช้ภาพที่ใหญ่ขึ้น',
  tooLarge: 'ภาพมีความละเอียดสูงเกินกำหนด กรุณาย่อขนาดภาพ',
} as const;

/* ------------------------------------------------------- dimensions ------- */

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  // Walk the marker chain looking for a Start Of Frame, which carries the size.
  let offset = 2; // skip SOI

  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;

    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;

    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15. DHT (0xc4), JPG (0xc8) and DAC (0xcc)
    // sit in the same numeric range but are not frame headers.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }

    offset += 2 + length;
  }

  return null;
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, "IHDR".
  if (bytes.byteLength < 24) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 30) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

  if (format === 'VP8 ') {
    // Lossy: 14-bit dimensions after the 3-byte start code at offset 23.
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }

  if (format === 'VP8L') {
    // Lossless: 14 bits each, packed little-endian from offset 21.
    const packed = view.getUint32(21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }

  if (format === 'VP8X') {
    // Extended: 24-bit canvas size minus one, from offset 24.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { width, height };
  }

  return null;
}

/** Pixel dimensions from the container header, or null when unreadable. */
export function readImageDimensions(
  bytes: Uint8Array,
  contentType: SupportedImageType,
): ImageDimensions | null {
  const dimensions =
    contentType === 'image/jpeg'
      ? readJpegDimensions(bytes)
      : contentType === 'image/png'
        ? readPngDimensions(bytes)
        : readWebpDimensions(bytes);

  if (!dimensions) return null;
  if (dimensions.width <= 0 || dimensions.height <= 0) return null;
  return dimensions;
}

/* ---------------------------------------------------- metadata strip ------ */

/**
 * Removes JPEG APPn and COM segments.
 *
 * APP1 holds EXIF (GPS, device, capture time) and XMP; APP2 holds ICC and
 * sometimes Flashpix; APP13 holds Photoshop IRB, which can contain IPTC
 * captions. None of it is needed to print a membership card, and all of it
 * would otherwise sit in the bucket attached to a named person.
 *
 * Everything from the Start Of Scan onwards is image data and is copied
 * verbatim, so the result is still a valid JPEG.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  const keep: Array<{ start: number; end: number }> = [];
  let offset = 2;

  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) break;

    const marker = bytes[offset + 1]!;

    if (marker === 0xda) {
      // Start Of Scan: the rest of the file is entropy-coded image data.
      keep.push({ start: offset, end: bytes.byteLength });
      break;
    }

    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push({ start: offset, end: offset + 2 });
      offset += 2;
      continue;
    }

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) break;

    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) {
      keep.push({ start: offset, end: offset + 2 + length });
    }

    offset += 2 + length;
  }

  const total = keep.reduce((sum, range) => sum + (range.end - range.start), 2);
  const output = new Uint8Array(total);
  output.set([0xff, 0xd8], 0);

  let cursor = 2;
  for (const range of keep) {
    output.set(bytes.subarray(range.start, range.end), cursor);
    cursor += range.end - range.start;
  }

  return output;
}

/** True when the JPEG carries an EXIF or XMP segment. */
export function hasJpegMetadata(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return false;

    const marker = bytes[offset + 1]!;
    if (marker === 0xda) return false;
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) return true;

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return false;
    offset += 2 + length;
  }

  return false;
}

/* ------------------------------------------------------- validation ------- */

/**
 * Safe pixel bounds for a member photo.
 *
 * The owner decision in Issue #52 keeps the applicant's full frame rather than
 * enforcing a crop or aspect ratio. Dimension and byte limits still bound
 * storage, memory and print quality.
 */
export const MEMBER_PHOTO_LIMITS = {
  minWidth: 300,
  minHeight: 400,
  maxWidth: 2400,
  maxHeight: 3200,
} as const;

export interface VerifiedMemberPhoto {
  bytes: Uint8Array;
  contentType: SupportedImageType;
  dimensions: ImageDimensions;
  /** True when metadata segments were present and removed. */
  metadataStripped: boolean;
}

export interface VerifyMemberPhotoOptions {
  /**
   * Enforce the association's print-quality recommendation.
   *
   * Applicant uploads should satisfy it. The iApp `face` candidate is already
   * cropped and sized by the provider, however, and upscaling those bytes would
   * not add detail. That path may therefore disable only this recommendation;
   * every decoding, encoding, maximum-size and metadata control still applies.
   */
  requirePrintMinimum?: boolean;
}

/**
 * Verifies the dimensions and encoding of a member photo and removes metadata.
 *
 * Throws `ApiError` with an applicant-safe message; each one says what to do,
 * because "invalid image" leaves the applicant with no next step.
 */
export function verifyMemberPhoto(
  bytes: Uint8Array,
  contentType: SupportedImageType,
  options: VerifyMemberPhotoOptions = {},
): VerifiedMemberPhoto {
  const dimensions = readImageDimensions(bytes, contentType);
  if (!dimensions) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', MESSAGES.undecodable);
  }

  const requirePrintMinimum = options.requirePrintMinimum ?? true;
  if (
    requirePrintMinimum &&
    (dimensions.width < MEMBER_PHOTO_LIMITS.minWidth ||
      dimensions.height < MEMBER_PHOTO_LIMITS.minHeight)
  ) {
    throw new ApiError('VALIDATION_FAILED', MESSAGES.tooSmall);
  }

  if (
    dimensions.width > MEMBER_PHOTO_LIMITS.maxWidth ||
    dimensions.height > MEMBER_PHOTO_LIMITS.maxHeight
  ) {
    throw new ApiError('VALIDATION_FAILED', MESSAGES.tooLarge);
  }

  if (contentType !== 'image/jpeg') {
    // PNG and WebP metadata lives in chunks this module does not rewrite. The
    // stored photo is therefore always re-encoded to JPEG by the client, and
    // anything else is refused rather than stored with metadata intact.
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', MESSAGES.undecodable);
  }

  const hadMetadata = hasJpegMetadata(bytes);
  const stripped = hadMetadata ? stripJpegMetadata(bytes) : bytes;

  // Stripping must not have broken the container.
  if (readImageDimensions(stripped, contentType) === null) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', MESSAGES.undecodable);
  }

  return {
    bytes: stripped,
    contentType,
    dimensions,
    metadataStripped: hadMetadata,
  };
}
