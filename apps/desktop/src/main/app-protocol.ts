import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TILE_ROUTE_PREFIX } from './tile-cache.js';

/**
 * The renderer is served from a custom scheme, not from `file:`.
 *
 * Vite emits `<script type="module" crossorigin>` and `<link rel="stylesheet" crossorigin>`.
 * Both are CORS fetches, and a `file:` document has an opaque origin, so Chromium blocks
 * every one of them: the packaged app parsed index.html, loaded nothing else, and showed an
 * empty `#root` on the user-agent's dark background. Nothing appeared in the log, because
 * nothing crashed — the page simply had no script and no stylesheet.
 *
 * `file:` could not have worked here anyway. Cesium creates Web Workers for terrain and
 * imagery decoding, and a worker cannot be constructed from an opaque origin either, so the
 * globe would have failed a second time even if the bundle had loaded.
 *
 * A registered scheme gives the renderer a real tuple origin. CORS passes, workers are
 * allowed, and `'self'` in the Content-Security-Policy finally means something specific
 * (src/main/csp.ts) instead of matching nothing.
 */
export const APP_SCHEME = 'worldview';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Extensions the renderer bundle actually contains, plus what Cesium loads at run time. */
const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.ktx2', 'image/ktx2'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.pbf', 'application/x-protobuf'],
]);

/**
 * A glyph range the app does not bundle (apps/desktop/assets/fonts has Latin, Greek and
 * Cyrillic). MapLibre asks for the range of every character in every label; a 404 for,
 * say, a vessel name in Hangul would be an error each time. An empty range is valid and
 * means "no glyphs here": those characters are simply not drawn.
 */
export const GLYPH_RANGE_PATH = /^\/fonts\/[^/]{1,64}\/\d{1,5}-\d{1,5}\.pbf$/;

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * Map a request URL onto a file inside the renderer directory, or `undefined` if it does not
 * belong to this app. The containment check is the security boundary: a handler that joined
 * blindly would serve any file on the disk to a page that asked for `../../../etc/passwd`.
 */
export function resolveRendererAsset(rendererDir: string, requestUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return undefined;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes('\0')) return undefined;
  // A backslash is a separator on Windows but an ordinary character to the URL parser, so it
  // is a way to smuggle a path past a check that only looks at `/`.
  if (pathname.includes('\\')) return undefined;
  // Refuse traversal rather than normalising it away. `path.posix.normalize` would turn
  // `/../../../etc/passwd` into `/etc/passwd`, which lands inside the bundle and is harmless
  // — but a request that asks to leave the bundle is not one to answer quietly.
  if (pathname.split('/').some((segment) => segment === '..')) return undefined;
  if (pathname === '' || pathname === '/') pathname = '/index.html';

  const root = path.resolve(rendererDir);
  const candidate = path.resolve(root, `.${path.posix.normalize(pathname)}`);
  // Defence in depth: whatever the parsing above let through, the file must be in the bundle.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
  return candidate;
}

interface ProtocolLike {
  registerSchemesAsPrivileged(customSchemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void;
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
}

/**
 * Must run before `app.whenReady()`: Chromium reads the scheme registry when it starts the
 * network service, and a scheme registered later is treated as non-standard — no origin, and
 * therefore none of the things this exists to fix.
 */
export function registerAppScheme(protocol: ProtocolLike): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true, // gives it a real origin, which is the entire point
        secure: true, // counts as a secure context: workers, crypto.subtle, no mixed-content downgrade
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true, // Cesium range-requests its terrain tiles
      },
    },
  ]);
}

/**
 * Serve `rendererDir` over the app scheme. Call once, after the app is ready.
 *
 * Files are read with `fs`, not with `net.fetch` on a file: URL. In a packaged build the
 * renderer lives *inside* `app.asar`, and Electron's asar support is a patch over Node's
 * `fs` — Chromium's own file loader knows nothing about it. Fetching
 * `file://…/app.asar/dist/renderer/index.html` is therefore not reliably a file at all,
 * while `readFile` on that path is exactly what asar was built to answer.
 */
export function serveRenderer(
  protocol: ProtocolLike,
  rendererDir: string,
  onError?: (message: string) => void,
  routes: { tiles?: (pathname: string) => Promise<Response> } = {},
): void {
  protocol.handle(APP_SCHEME, async (request) => {
    // Map tiles from the disk cache (tile-cache.ts) share the page's origin, so they need no
    // CORS and no Content-Security-Policy exception of their own.
    if (routes.tiles) {
      const url = safeUrl(request.url);
      if (url && url.host === APP_HOST && url.pathname.startsWith(TILE_ROUTE_PREFIX)) return routes.tiles(url.pathname);
    }
    const file = resolveRendererAsset(rendererDir, request.url);
    if (!file) {
      onError?.(`refused a renderer request outside the bundle: ${request.url.slice(0, 200)}`);
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    try {
      const bytes = await readFile(file);
      // A module script served as application/octet-stream is rejected by the module
      // loader, so the type is set explicitly rather than guessed.
      return new Response(bytes, { status: 200, headers: { 'Content-Type': contentTypeFor(file) } });
    } catch (error) {
      if (isGlyphRange(request.url))
        return new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } });
      onError?.(`could not read ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  });
}

function isGlyphRange(raw: string): boolean {
  const url = safeUrl(raw);
  if (!url || url.host !== APP_HOST) return false;
  try {
    return GLYPH_RANGE_PATH.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}
