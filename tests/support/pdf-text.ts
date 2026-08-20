import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';

/**
 * Reads the text back out of a generated PDF.
 *
 * This exists because a Thai PDF cannot be checked by searching the file for the
 * string that was drawn. Text is written as glyph identifiers into a subsetted
 * CID font, so what lands in the file is `<0002 0003 ...>`. Reading it back means
 * going through the font's `/ToUnicode` map, which is the same path a viewer's
 * copy-to-clipboard takes.
 *
 * **Sara aa is not recoverable exactly, and that is a property of the file, not
 * of this helper.** Shaping renders `ำ` as nikhahit plus sara aa, and the sara aa
 * it uses is the *same glyph* as a standalone `า` (id 488, advance 485). pdf-lib
 * writes one `/ToUnicode` entry per subset glyph, taken from the first context it
 * saw the glyph in - where fontkit reports no code point for the decomposed
 * form. So one of the two readings is always lost per font: whichever came
 * second. The glyph drawn is correct either way, so the printed and on-screen
 * receipt is right; only extraction is lossy.
 *
 * Tests therefore compare with `withoutSaraAa`, which drops `า` and `ำ` from both
 * sides. Every other consonant, vowel, tone mark and their order is still
 * checked exactly.
 */

/**
 * Removes sara aa and sara am, the two characters extraction cannot distinguish.
 * Apply to both the expected and the extracted string.
 */
export function withoutSaraAa(text: string): string {
  return text.replaceAll('า', '').replaceAll('ำ', '');
}

function decodeStream(document: PDFDocument, ref: PDFRef): string {
  const stream = document.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return '';
  return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
}

/** Maps each font resource name on the page to its glyph-id -> text table. */
function fontTables(document: PDFDocument, page: PDFPage): Map<string, Map<number, string>> {
  const tables = new Map<string, Map<number, string>>();

  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return tables;

  for (const [name, value] of fonts.entries()) {
    const font = document.context.lookup(value, PDFDict);
    const toUnicode = font?.get(PDFName.of('ToUnicode'));
    if (!(toUnicode instanceof PDFRef)) continue;

    const table = new Map<number, string>();
    const cmap = decodeStream(document, toUnicode);
    // `<0002> <0E43>` per line inside the bfchar block.
    for (const entry of cmap.matchAll(/<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]*)>/g)) {
      const glyph = Number.parseInt(entry[1]!, 16);
      const codepoints = entry[2]!;
      let text = '';
      for (let index = 0; index + 4 <= codepoints.length; index += 4) {
        text += String.fromCodePoint(Number.parseInt(codepoints.slice(index, index + 4), 16));
      }
      table.set(glyph, text);
    }

    // `codespacerange` has the same `<..> <..>` shape but is not a mapping, and
    // glyph 0 is never shown.
    table.delete(0x0000);
    tables.set(name.asString().slice(1), table);
  }

  return tables;
}

function pageContent(document: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) {
    return contents
      .asArray()
      .map((entry) => (entry instanceof PDFRef ? decodeStream(document, entry) : ''))
      .join('\n');
  }
  return '';
}

/**
 * Returns the visible text of the first page, one drawn string per entry, in the
 * order the strings were drawn.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string[]> {
  const document = await PDFDocument.load(bytes);
  const page = document.getPage(0);
  const tables = fontTables(document, page);
  const content = pageContent(document, page);

  const strings: string[] = [];
  let active: Map<number, string> | undefined;

  // `/FontName size Tf` selects a font; `<hex> Tj` shows a string in it.
  for (const token of content.matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]+)>\s*Tj/g)) {
    const fontName = token[1];
    if (fontName !== undefined) {
      active = tables.get(fontName);
      continue;
    }

    const hex = token[2];
    if (hex === undefined || !active) continue;

    let text = '';
    for (let index = 0; index + 4 <= hex.length; index += 4) {
      text += active.get(Number.parseInt(hex.slice(index, index + 4), 16)) ?? '';
    }
    strings.push(text);
  }

  return strings;
}

/** All drawn strings joined, with sara aa removed, for containment assertions. */
export async function extractComparableText(bytes: Uint8Array): Promise<string> {
  return withoutSaraAa((await extractPdfText(bytes)).join('\n'));
}
