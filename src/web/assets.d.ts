/**
 * Vite turns an image import into a URL string. Declared here because the web
 * project does not include Vite's own client types for images by default, and
 * an untyped import would be `any`.
 */
declare module '*.png' {
  const url: string;
  export default url;
}
