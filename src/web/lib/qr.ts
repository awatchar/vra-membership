import jsQR from 'jsqr';
import { loadImage } from './image';

/**
 * Reading the QR on a payment slip, in the browser.
 *
 * This is the preferred path for verification, and the reason is privacy rather
 * than performance: if the browser decodes the QR, only the payload is sent and
 * the slip image never leaves the device (Issue #1 section 18). The image upload
 * exists as a fallback for a slip whose QR will not read - a crumpled photo, a
 * screenshot cropped too tightly - and it is discarded server-side.
 *
 * `BarcodeDetector` is tried first because it is the platform's own decoder and
 * far more tolerant of a photographed code than a JavaScript one. jsQR is the
 * fallback for the browsers that do not have it, which as of 2026 is still
 * Safari and Firefox.
 */

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function nativeDetector(): BarcodeDetectorConstructor | null {
  const candidate = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof candidate === 'function' ? (candidate as BarcodeDetectorConstructor) : null;
}

async function decodeWithNative(file: Blob): Promise<string | null> {
  const Detector = nativeDetector();
  if (!Detector) return null;

  try {
    const detector = new Detector({ formats: ['qr_code'] });
    const bitmap = await createImageBitmap(file);
    const results = await detector.detect(bitmap);
    const value = results[0]?.rawValue;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function decodeWithJsQr(file: Blob): Promise<string | null> {
  const image = await loadImage(file);

  // Downscaled first: jsQR is pure JavaScript and scans every pixel, so a
  // 12-megapixel photo takes seconds on a phone. A QR remains readable well
  // below that.
  const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(image.bitmap, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);

  const result = jsQR(data.data, width, height, { inversionAttempts: 'attemptBoth' });
  return result?.data ?? null;
}

/** Returns the QR payload, or null when the code could not be read. */
export async function decodeQrFromImage(file: Blob): Promise<string | null> {
  return (await decodeWithNative(file)) ?? (await decodeWithJsQr(file));
}

/**
 * A very loose check that a payload looks like a Thai bank slip QR.
 *
 * Only enough to avoid sending an obviously unrelated code - a Wi-Fi QR, a URL -
 * to an endpoint that costs money per call. What counts as a valid slip is the
 * provider's decision, not the browser's.
 */
export function looksLikeSlipPayload(payload: string): boolean {
  const trimmed = payload.trim();
  if (trimmed.length < 12 || trimmed.length > 512) return false;
  return /^[0-9A-Za-z.\-_:/+=]+$/.test(trimmed);
}
