import { DEV_SERVER_ORIGIN } from '../shared/app-origin.js';

/**
 * Content Security Policy for the renderer, applied as a response header by
 * `session.defaultSession.webRequest.onHeadersReceived` (main.ts) so it also
 * covers the file: origin where <meta> CSP would be the only alternative.
 *
 * Directive notes (docs/security/THREAT-MODEL.md, "XSS"):
 *  - script-src 'self' only: no inline scripts, no eval — Cesium and MapLibre are
 *    bundled by Vite and run from the app origin; WebAssembly needs 'wasm-unsafe-eval'
 *    (MapLibre/pmtiles decoders) which does NOT permit JS eval. This is the directive
 *    that costs something: @cesium/widgets bundles Knockout, which evaluates a string at
 *    module scope, so the renderer imports @cesium/engine instead and builds a
 *    CesiumWidget rather than a Viewer (packages/render-cesium/src/cesium-module.ts).
 *    Relaxing this to 'unsafe-eval' to get the widgets back is not an option.
 *  - style-src 'unsafe-inline': Cesium and MapLibre inject inline style
 *    attributes and <style> elements at runtime; there is no nonce path for them.
 *    Inline *styles* cannot execute script; the residual risk is UI redress only.
 *  - img-src https: allows raster/vector tile hosts and camera snapshots, plus
 *    http://127.0.0.1:* for the loopback camera relay; blob:/data:
 *    for canvas exports and generated icons.
 *  - connect-src https:/wss: for tiles, provider APIs proxied through main are NOT
 *    used by the renderer (all provider traffic is in main), but MapLibre/Cesium fetch
 *    tiles and terrain directly. Loopback http/ws is for local sidecars (go2rtc, readsb)
 *    and the Vite dev server.
 *  - worker-src blob: for MapLibre's worker bundle; object-src/frame-src 'none'.
 */
export interface CspOptions {
  dev?: boolean;
  devServerOrigin?: string;
}

const LOOPBACK_CONNECT = ['http://127.0.0.1:*', 'ws://127.0.0.1:*', 'http://localhost:*', 'ws://localhost:*'];

export function buildCspDirectives(opts: CspOptions = {}): Record<string, string[]> {
  const devOrigin = opts.devServerOrigin ?? DEV_SERVER_ORIGIN;
  const devWs = devOrigin.replace(/^http/, 'ws');
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    // Loopback is the camera relay: MJPEG streams and relayed frames are served from
    // 127.0.0.1 on a random port with a per-camera token, so <img> has to be allowed to
    // load them. No other http: origin is.
    'img-src': ["'self'", 'data:', 'blob:', 'https:', ...LOOPBACK_CONNECT.filter((o) => o.startsWith('http'))],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:', 'https:', ...LOOPBACK_CONNECT.filter((o) => o.startsWith('http'))],
    'connect-src': ["'self'", 'https:', 'wss:', ...LOOPBACK_CONNECT],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  if (opts.dev) {
    directives['script-src'] = [...directives['script-src']!, devOrigin];
    directives['style-src'] = [...directives['style-src']!, devOrigin];
    directives['connect-src'] = [...directives['connect-src']!, devOrigin, devWs];
    directives['img-src'] = [...directives['img-src']!, devOrigin];
    directives['font-src'] = [...directives['font-src']!, devOrigin];
    directives['worker-src'] = [...directives['worker-src']!, devOrigin];
  }
  return directives;
}

export function buildCsp(opts: CspOptions = {}): string {
  return Object.entries(buildCspDirectives(opts)).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/** Response headers merged into every document/worker response of the app origin. */
export function securityHeaders(opts: CspOptions = {}): Record<string, string[]> {
  return {
    'Content-Security-Policy': [buildCsp(opts)],
    'X-Content-Type-Options': ['nosniff'],
    'Referrer-Policy': ['no-referrer'],
    'Cross-Origin-Opener-Policy': ['same-origin'],
    'Permissions-Policy': ['camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()'],
  };
}

/** Pure merge used by the onHeadersReceived listener: existing headers win nothing; ours are authoritative. */
export function mergeSecurityHeaders(existing: Record<string, string[]> | undefined, opts: CspOptions = {}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const ours = securityHeaders(opts);
  const ourKeys = new Set(Object.keys(ours).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(existing ?? {})) if (!ourKeys.has(k.toLowerCase())) out[k] = v;
  return { ...out, ...ours };
}
