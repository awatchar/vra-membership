/**
 * Runtime guard for pdf-lib's unused standard-font support.
 *
 * The receipt always embeds Sarabun because PDF's built-in fonts cannot encode
 * Thai. pdf-lib imports the metrics for all 14 built-in fonts eagerly even when
 * none is embedded, so Wrangler aliases that package to this small module.
 * Keep the names because pdf-lib inspects them while loading; the first actual
 * attempt to embed one fails explicitly instead of producing a broken receipt.
 */

export const FontNames = Object.freeze({
  Courier: 'Courier',
  CourierBold: 'Courier-Bold',
  CourierOblique: 'Courier-Oblique',
  CourierBoldOblique: 'Courier-BoldOblique',
  Helvetica: 'Helvetica',
  HelveticaBold: 'Helvetica-Bold',
  HelveticaOblique: 'Helvetica-Oblique',
  HelveticaBoldOblique: 'Helvetica-BoldOblique',
  TimesRoman: 'Times-Roman',
  TimesRomanBold: 'Times-Bold',
  TimesRomanItalic: 'Times-Italic',
  TimesRomanBoldItalic: 'Times-BoldItalic',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
});

const unsupported = (): never => {
  throw new Error('Built-in PDF fonts are disabled; embed a vendored Thai-capable font instead');
};

const disabledEncoding = Object.freeze({
  canEncodeUnicodeCodePoint: unsupported,
  encodeUnicodeCodePoint: unsupported,
  supportedCodePoints: [] as number[],
});

export const Encodings = Object.freeze({
  Symbol: disabledEncoding,
  ZapfDingbats: disabledEncoding,
  WinAnsi: disabledEncoding,
});

export class Font {
  static load(): never {
    return unsupported();
  }
}
