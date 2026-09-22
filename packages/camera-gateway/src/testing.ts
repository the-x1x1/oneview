import { CameraError } from './errors.js';
import type { ByteFetcher, FetchBytesOptions, FetchBytesResult, UpstreamOpener, UpstreamStream } from './types.js';

/**
 * Test doubles for the camera gateway. No network: every upstream is a scripted
 * responder keyed by URL. Used by unit, failure and integration tests.
 */
export const JPEG_BYTES: Uint8Array = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0xff, 0xd9,
]);
export const PNG_BYTES: Uint8Array = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
export const HTML_BYTES: Uint8Array = new TextEncoder().encode(
  '<!doctype html><html><body>Please use a browser</body></html>',
);

export type ScriptedResponse =
  | { status?: number; headers?: Record<string, string>; bytes?: Uint8Array; body?: string }
  | { error: 'timeout' | 'network' | 'too-large' };

export type Responder = (url: string, opts: FetchBytesOptions) => ScriptedResponse;

export interface FakeFetcher extends ByteFetcher {
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

export function fakeByteFetcher(responder: Responder): FakeFetcher {
  const calls: FakeFetcher['calls'] = [];
  const fn = Object.assign(
    async (url: string, opts: FetchBytesOptions): Promise<FetchBytesResult> => {
      calls.push({ url, headers: { ...(opts.headers ?? {}) } });
      if (opts.signal?.aborted) throw new CameraError('CANCELLED', 'cancelled');
      const r = responder(url, opts);
      if ('error' in r) {
        if (r.error === 'timeout') throw new CameraError('TIMEOUT', 'upstream timed out');
        if (r.error === 'too-large')
          throw new CameraError('TOO_LARGE', `body exceeded ${opts.maxBytes} bytes`, { retryable: false });
        throw new CameraError('NETWORK', 'fetch failed: ECONNREFUSED');
      }
      const bytes = r.bytes ?? (r.body !== undefined ? new TextEncoder().encode(r.body) : new Uint8Array());
      if (bytes.byteLength > opts.maxBytes)
        throw new CameraError('TOO_LARGE', `body exceeded ${opts.maxBytes} bytes`, { retryable: false });
      return { status: r.status ?? 200, headers: lower(r.headers ?? {}), bytes };
    },
    { calls },
  );
  return fn;
}

export interface ScriptedStream {
  status?: number;
  headers?: Record<string, string>;
  chunks: Uint8Array[] | (() => AsyncIterable<Uint8Array>);
}

export interface FakeOpener extends UpstreamOpener {
  calls: Array<{ url: string; headers: Record<string, string> }>;
  cancelled: number;
}

export function fakeUpstreamOpener(
  responder: (url: string) => ScriptedStream | { error: 'timeout' | 'network' },
): FakeOpener {
  const calls: FakeOpener['calls'] = [];
  const fn: FakeOpener = Object.assign(
    async (url: string, opts: { headers?: Record<string, string>; signal: AbortSignal }): Promise<UpstreamStream> => {
      calls.push({ url, headers: { ...(opts.headers ?? {}) } });
      const r = responder(url);
      if ('error' in r)
        throw r.error === 'timeout'
          ? new CameraError('TIMEOUT', 'upstream timed out')
          : new CameraError('NETWORK', 'fetch failed: ECONNRESET');
      const body = typeof r.chunks === 'function' ? r.chunks() : fromChunks(r.chunks, opts.signal);
      return {
        status: r.status ?? 200,
        headers: lower(r.headers ?? { 'content-type': 'multipart/x-mixed-replace; boundary=frame' }),
        body,
        cancel: () => {
          fn.cancelled++;
        },
      };
    },
    { calls, cancelled: 0 },
  );
  return fn;
}

async function* fromChunks(chunks: Uint8Array[], signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for (const c of chunks) {
    if (signal.aborted) return;
    yield c;
  }
}

/** An MJPEG multipart body carrying `n` frames. */
export function mjpegChunks(n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < n; i++) {
    out.push(enc.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG_BYTES.byteLength}\r\n\r\n`));
    out.push(JPEG_BYTES);
    out.push(enc.encode('\r\n'));
  }
  return out;
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}
