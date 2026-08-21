/**
 * Synthetic JPEG builders for tests.
 *
 * These are structurally valid JPEGs assembled by hand rather than real photos:
 * the tests need a container whose header says a particular size and whose
 * metadata segments are known, and a real photo would give neither.
 */

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

/** SOF0 with the given dimensions: one 8-bit component, no subsampling. */
function startOfFrame(width: number, height: number): number[] {
  return segment(0xc0, [
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
}

/** APP1 carrying an EXIF header and a recognisable GPS-like payload. */
function exifSegment(): number[] {
  const marker = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const payload = [...marker, ...new TextEncoder().encode('GPSLatitude=13.7563')];
  return segment(0xe1, payload);
}

/** APP13 Photoshop IRB, another place captions and locations hide. */
function photoshopSegment(): number[] {
  const payload = [...new TextEncoder().encode('Photoshop 3.0\0'), 0x38, 0x42, 0x49, 0x4d];
  return segment(0xed, payload);
}

/** COM comment segment. */
function commentSegment(text: string): number[] {
  return segment(0xfe, [...new TextEncoder().encode(text)]);
}

/** Minimal scan data so the file has a body after the SOS marker. */
function startOfScan(): number[] {
  return [...segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), 0x00, 0x11, 0x22, 0x33];
}

export interface JpegOptions {
  width: number;
  height: number;
  withExif?: boolean;
  withPhotoshop?: boolean;
  comment?: string;
  /**
   * Extra scan bytes to append.
   *
   * Absolute rather than "pad the file to N bytes": a total-size target would
   * give a file with metadata less scan data than one without, so stripping the
   * first could never reproduce the second.
   */
  scanPaddingBytes?: number;
}

export function makeJpeg(options: JpegOptions): Uint8Array {
  const parts: number[] = [...SOI];

  if (options.withExif) parts.push(...exifSegment());
  if (options.withPhotoshop) parts.push(...photoshopSegment());
  if (options.comment !== undefined) parts.push(...commentSegment(options.comment));

  parts.push(...startOfFrame(options.width, options.height));
  parts.push(...startOfScan());

  for (let index = 0; index < (options.scanPaddingBytes ?? 0); index += 1) {
    parts.push(0x55);
  }

  parts.push(...EOI);
  return new Uint8Array(parts);
}

/** A member photo within the safe default dimensions. */
export function makeMemberPhoto(overrides: Partial<JpegOptions> = {}): Uint8Array {
  return makeJpeg({ width: 600, height: 800, scanPaddingBytes: 200, ...overrides });
}

export function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Lossy WebP (`VP8 `) with the given dimensions. */
export function makeWebp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width & 0x3fff, true);
  view.setUint16(28, height & 0x3fff, true);
  return bytes;
}
