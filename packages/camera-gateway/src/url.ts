import { createHash } from 'node:crypto';
import { CameraError } from './errors.js';
import type { CameraSourceKind } from './types.js';

/**
 * Camera URL handling. A source URL is untrusted input from the settings UI:
 *  - only the schemes a gateway can serve are accepted (the caller says which);
 *  - `user:password@` is removed and handed back separately so it can go to the
 *    SecretStore — the stored record never contains it;
 *  - the normalized URL (lower-cased scheme/host, default port dropped, no hash,
 *    no credentials) is what the camera id is derived from, so the same camera
 *    registered twice gets the same id.
 */
export interface ParsedCameraUrl {
  /** Normalized URL without credentials. */
  url: string;
  scheme: 'http' | 'https' | 'rtsp' | 'rtsps';
  host: string;
  port: number | undefined;
  credential?: { username: string; password: string };
  kind: CameraSourceKind;
}

const CAMERA_ID_HEX = 12;
export const CAMERA_ID_PATTERN = /^[0-9a-f]{12}$/;

export function parseCameraUrl(raw: string, allowedSchemes: ReadonlyArray<ParsedCameraUrl['scheme']>): ParsedCameraUrl {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new CameraError('INVALID_URL', 'camera url is empty');
  if (raw.length > 2048) throw new CameraError('INVALID_URL', 'camera url is too long');
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new CameraError('INVALID_URL', 'camera url is not a valid absolute URL');
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!isScheme(scheme)) throw new CameraError('UNSUPPORTED_SCHEME', `scheme "${scheme}" is not a camera scheme`);
  if (!allowedSchemes.includes(scheme)) {
    const hint =
      scheme === 'rtsp' || scheme === 'rtsps'
        ? 'RTSP sources need the go2rtc gateway (see docs/operator/cameras.md)'
        : `scheme "${scheme}" is not accepted by this gateway`;
    throw new CameraError('UNSUPPORTED_SCHEME', hint);
  }
  if (!parsed.hostname) throw new CameraError('INVALID_URL', 'camera url has no host');

  let credential: ParsedCameraUrl['credential'];
  if (parsed.username || parsed.password) {
    credential = { username: safeDecode(parsed.username), password: safeDecode(parsed.password) };
    parsed.username = '';
    parsed.password = '';
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : undefined;
  const url = parsed.toString();
  const out: ParsedCameraUrl = { url, scheme, host: parsed.hostname, port, kind: inferKind(scheme, parsed) };
  if (credential) out.credential = credential;
  return out;
}

function isScheme(s: string): s is ParsedCameraUrl['scheme'] {
  return s === 'http' || s === 'https' || s === 'rtsp' || s === 'rtsps';
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Source kind heuristic (documented in docs/operator/cameras.md):
 *   rtsp(s)://                          → rtsp
 *   *.m3u8                              → hls
 *   *.mjpg | *.mjpeg | mjpeg/… | action=stream | /video | /stream  → mjpeg
 *   everything else (jpg/jpeg/png/cgi)  → snapshot (polled still image)
 */
export function inferKind(scheme: string, u: URL): CameraSourceKind {
  if (scheme === 'rtsp' || scheme === 'rtsps') return 'rtsp';
  const path = u.pathname.toLowerCase();
  const query = u.search.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (
    /\.(mjpg|mjpeg)$/.test(path) ||
    /(^|\/)mjpe?g(\/|$)/.test(path) ||
    /action=stream/.test(query) ||
    /\/(video|stream)(\.cgi)?$/.test(path)
  )
    return 'mjpeg';
  return 'snapshot';
}

/** Deterministic camera id: first 12 hex characters of sha256(normalized url). */
export function cameraIdFor(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex').slice(0, CAMERA_ID_HEX);
}

export function isCameraId(value: string): boolean {
  return CAMERA_ID_PATTERN.test(value);
}

/** Basic auth header value for a stored `user:password` credential. */
export function basicAuthHeader(credential: string): string {
  return `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

export function credentialKeyFor(cameraId: string): string {
  return `camera.${cameraId}.credential`;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}
