/**
 * Image handling in the browser.
 *
 * Shrinks large uploads while preserving their full frame and aspect ratio.
 * Canvas re-encoding has a useful side effect: EXIF, GPS coordinates and the
 * original camera metadata do not survive. The server strips JPEG metadata too
 * because a small JPEG can skip re-encoding here.
 */

/** Longest edge of an ID card image sent for OCR. */
export const CARD_MAX_EDGE = 1600;
const JPEG_QUALITY = 0.9;

export interface LoadedImage {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

/**
 * Decodes a file to something drawable.
 *
 * `createImageBitmap` is preferred because it decodes off the main thread and
 * honours EXIF orientation, which matters: a photo taken in portrait on a phone
 * is stored rotated with an orientation flag, and drawing it without applying
 * that flag produces a sideways card that OCR cannot read.
 */
export async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Fall through to the element path, which some browsers need for HEIC.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์ภาพนี้ได้'));
      image.src = url;
    });
    return { bitmap: element, width: element.naturalWidth, height: element.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', JPEG_QUALITY);
  });
  if (!blob) throw new Error('ไม่สามารถประมวลผลภาพนี้ได้ กรุณาลองภาพอื่น');
  return blob;
}

/**
 * Scales an image down so its longest edge is at most `maxEdge`.
 *
 * A modern phone camera produces images several times larger than OCR can use,
 * and the upload happens on mobile data. Scaling before sending is the
 * difference between a few hundred kilobytes and several megabytes.
 */
export async function downscale(file: Blob, maxEdge = CARD_MAX_EDGE): Promise<Blob> {
  const image = await loadImage(file);
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  if (scale === 1 && file.type === 'image/jpeg') return file;

  const canvas = canvasOf(Math.round(image.width * scale), Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('เบราว์เซอร์นี้ไม่รองรับการประมวลผลภาพ');
  context.drawImage(image.bitmap, 0, 0, canvas.width, canvas.height);

  return toJpeg(canvas);
}

/** Decodes a base64 payload from the API into a blob for previewing. */
export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
}
