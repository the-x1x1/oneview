/**
 * Where the renderer is allowed to live. Production serves the bundled renderer over the
 * app's own scheme (src/main/app-protocol.ts); development loads the Vite dev server.
 * Navigation anywhere else is blocked in main. Shared between main, preload and tests;
 * imports nothing from Node.
 *
 * This used to be a `file:` URL under app.getAppPath(). That could not work: Vite emits
 * `crossorigin` module scripts and stylesheets, and a `file:` document has an opaque origin,
 * so Chromium blocked the app's own bundle and the packaged window came up empty.
 */
export const DEV_SERVER_ORIGIN = 'http://127.0.0.1:5173';
export const APP_ORIGIN = 'worldview://app';

export function isTrustedRendererUrl(url: string, opts: { dev: boolean; appDir?: string }): boolean {
  if (opts.dev) return url === DEV_SERVER_ORIGIN || url.startsWith(`${DEV_SERVER_ORIGIN}/`);
  // The protocol handler already refuses anything outside the renderer directory, so the
  // origin is the whole check here. The trailing slash matters: it keeps
  // `worldview://app.example.com/` from passing as a prefix of the real origin.
  return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
}
