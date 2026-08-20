/**
 * Ambient types for binary assets bundled into the Worker.
 *
 * `wrangler.jsonc` declares a `Data` module rule for `**\/*.ttf`, so an import
 * resolves to the file's bytes. TypeScript has no way to know that, hence this
 * declaration.
 */
declare module '*.ttf' {
  const bytes: ArrayBuffer;
  export default bytes;
}
