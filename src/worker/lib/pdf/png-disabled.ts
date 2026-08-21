/**
 * Runtime guard for pdf-lib's unused PNG support.
 *
 * Receipts intentionally contain text and vector rules only. pdf-lib otherwise
 * bundles a PNG/APNG decoder even though no receipt calls `embedPng`. Keeping a
 * throwing implementation makes a future image addition fail visibly until
 * the Wrangler alias is deliberately removed and the bundle cost is reviewed.
 */

const unsupported = (): never => {
  throw new Error('PNG embedding is disabled for receipt PDFs');
};

export default Object.freeze({
  decode: unsupported,
  toRGBA8: unsupported,
});
