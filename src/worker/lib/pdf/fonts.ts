import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import regularBytes from '../../../../assets/fonts/Sarabun-Regular.ttf';
import boldBytes from '../../../../assets/fonts/Sarabun-Bold.ttf';

/**
 * Thai font embedding for generated PDFs.
 *
 * Sarabun is used because the receipt is a Thai document and the standard PDF
 * fonts cannot encode Thai at all - `drawText` throws rather than producing
 * anything. It is vendored under `assets/fonts/` with its OFL licence rather
 * than fetched at runtime, so a receipt can always be produced even if the
 * network is unavailable.
 *
 * A note on Thai shaping, because it is easy to conclude wrongly that it is
 * broken. Sarabun positions vowels and tone marks through GSUB substitution
 * into pre-positioned, zero-advance glyphs, not through GPOS offsets. So a
 * layout run reports every offset as zero while still being correctly shaped -
 * what changes is the glyph chosen. `น้` uses one tone-mark glyph and `น้ำ`
 * uses a different one, because the mark has to sit differently when sara am
 * follows. Asserting on offsets would therefore look like a failure; asserting
 * that the glyph id changes with context is the real check.
 */

export interface ThaiFonts {
  regular: PDFFont;
  bold: PDFFont;
}

/**
 * Registers fontkit and embeds both weights.
 *
 * Subsetting is on: a receipt uses a few dozen glyphs, and embedding the whole
 * 90 KB face in every generated PDF would make each emailed attachment far
 * larger than the document it carries.
 */
export async function embedThaiFonts(document: PDFDocument): Promise<ThaiFonts> {
  document.registerFontkit(fontkit);

  const [regular, bold] = await Promise.all([
    document.embedFont(regularBytes, { subset: true }),
    document.embedFont(boldBytes, { subset: true }),
  ]);

  return { regular, bold };
}

/** Raw font bytes, for tests that inspect shaping directly. */
export const THAI_FONT_BYTES: ArrayBuffer = regularBytes;
