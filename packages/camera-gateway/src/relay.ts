import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { silentLogger, type Logger } from '@worldview/core';
import { CameraError, errorForStatus, toCameraError } from './errors.js';
import { assertImage } from './image.js';
import { hlsBaseFor, looksLikePlaylist, resolveContained, rewritePlaylist, type HlsBase } from './hls.js';
import { isLoopbackHost } from './url.js';
import { DEFAULT_FRAME_TIMEOUT_MS, MAX_FRAME_BYTES, type ByteFetcher, type UpstreamOpener } from './types.js';

/**
 * CameraRelay — a tiny HTTP server bound to 127.0.0.1 on a random port that the
 * renderer uses to display camera media without ever seeing the upstream URL or
 * its credentials.
 *
 *   GET /cam/<cameraId>/<token>            snapshot | mjpeg stream | clip | rewritten HLS playlist
 *   GET /cam/<cameraId>/<token>/r/<path>   HLS only: segment / nested playlist / key inside the
 *                                          registered playlist's directory on its origin
 *
 * Properties:
 *  - only cameras added through `add()` are reachable; there is no listing endpoint;
 *  - unknown ids and wrong tokens answer 404 (indistinguishable);
 *  - the relay never proxies an arbitrary URL — HLS references are resolved and
 *    contained to the registered playlist's directory, everything else is refused;
 *  - concurrent upstream connections are capped (503 beyond the cap);
 *  - credentials are resolved per request through the camera's `headers()` callback
 *    and never logged; log fields are limited to ids, status codes and byte counts.
 */
export interface RelayCamera {
  cameraId: string;
  /** Upstream URL without credentials. */
  url: string;
  /** `clip`: one recorded video file (TfL's MP4 JamCam clips), piped like an MJPEG stream. */
  kind: 'mjpeg' | 'hls' | 'snapshot' | 'clip';
  /** Per-request headers (credential injection). Resolved at request time, never stored. */
  headers(): Promise<Record<string, string>>;
}

export interface CameraRelayOptions {
  openUpstream: UpstreamOpener;
  fetchBytes: ByteFetcher;
  logger?: Logger;
  /** Max concurrent upstream connections across all cameras (default 4). */
  maxConcurrentStreams?: number;
  upstreamTimeoutMs?: number;
  /** Test hook: token generator (32 hex chars). */
  token?: () => string;
}

interface Entry {
  camera: RelayCamera;
  token: string;
  hls?: HlsBase;
}

const ROUTE = /^\/cam\/([0-9a-f]{12})\/([0-9a-f]{32})(?:\/r\/(.+))?$/;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const STREAM_CONTENT_TYPES =
  /^(multipart\/x-mixed-replace|image\/|video\/|audio\/|application\/octet-stream|binary\/octet-stream|application\/mp4|application\/vnd\.apple\.mpegurl|application\/x-mpegurl)/i;

export class CameraRelay {
  private readonly entries = new Map<string, Entry>();
  private readonly logger: Logger;
  private server: Server | undefined;
  private boundPort: number | undefined;
  private active = 0;
  private readonly max: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CameraRelayOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.max = Math.max(1, opts.maxConcurrentStreams ?? 4);
    this.timeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort!;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    if (address.address !== '127.0.0.1') {
      server.close();
      throw new CameraError('INTERNAL', `relay bound to ${address.address}, refusing to serve`);
    }
    this.server = server;
    this.boundPort = address.port;
    this.logger.info('camera relay listening', { port: address.port });
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.boundPort = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  isListening(): boolean {
    return this.server !== undefined;
  }
  port(): number | undefined {
    return this.boundPort;
  }
  activeStreams(): number {
    return this.active;
  }
  has(cameraId: string): boolean {
    return this.entries.has(cameraId);
  }

  add(camera: RelayCamera): void {
    this.assertNotSelf(camera.url);
    const existing = this.entries.get(camera.cameraId);
    const token = existing?.token ?? (this.opts.token ?? defaultToken)();
    const entry: Entry = { camera, token };
    if (camera.kind === 'hls') entry.hls = hlsBaseFor(camera.url);
    this.entries.set(camera.cameraId, entry);
  }

  remove(cameraId: string): void {
    this.entries.delete(cameraId);
  }

  urlFor(cameraId: string): string | undefined {
    const e = this.entries.get(cameraId);
    if (!e || this.boundPort === undefined) return undefined;
    return `http://127.0.0.1:${this.boundPort}/cam/${cameraId}/${e.token}`;
  }

  private assertNotSelf(url: string): void {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new CameraError('INVALID_URL', 'relay upstream url invalid');
    }
    if (
      this.boundPort !== undefined &&
      isLoopbackHost(u.hostname) &&
      Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === this.boundPort
    ) {
      throw new CameraError('INVALID_URL', 'a camera cannot point at the relay itself');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = ROUTE.exec(url.pathname);
    if (!m) return plain(res, 404, 'not found');
    const [, cameraId, token, rel] = m as unknown as [string, string, string, string | undefined];
    const entry = this.entries.get(cameraId);
    if (!entry || !tokensEqual(entry.token, token)) return plain(res, 404, 'not found');
    if (this.active >= this.max) {
      res.setHeader('Retry-After', '1');
      return plain(res, 503, 'too many streams');
    }

    this.active++;
    const abort = new AbortController();
    let closed = false;
    res.on('close', () => {
      closed = true;
      abort.abort();
    });
    const head = req.method === 'HEAD';
    try {
      if (rel !== undefined) {
        if (entry.camera.kind !== 'hls' || !entry.hls) return plain(res, 404, 'not found');
        const target = resolveContained(decodeRel(rel) + url.search, entry.hls);
        if (!target) {
          this.logger.warn('relay refused out-of-scope hls reference', { cameraId });
          return plain(res, 404, 'not found');
        }
        if (looksLikePlaylist(target, undefined)) await this.servePlaylist(entry, target, res, head, abort.signal);
        else await this.pipeUpstream(entry, target, res, head, abort.signal, () => closed);
        return;
      }
      switch (entry.camera.kind) {
        case 'snapshot':
          return await this.serveSnapshot(entry, res, head, abort.signal);
        case 'hls':
          return await this.servePlaylist(entry, entry.camera.url, res, head, abort.signal);
        case 'mjpeg':
        case 'clip':
          return await this.pipeUpstream(entry, entry.camera.url, res, head, abort.signal, () => closed, true);
        default:
          return plain(res, 404, 'not found');
      }
    } catch (err) {
      const ce = toCameraError(err);
      if (ce.code === 'CANCELLED' || closed) {
        if (!res.headersSent) res.destroy();
        return;
      }
      this.logger.warn('relay upstream failure', {
        cameraId,
        code: ce.code,
        ...(ce.httpStatus !== undefined ? { upstreamStatus: ce.httpStatus } : {}),
      });
      if (!res.headersSent)
        plain(res, statusFor(ce), ce.code === 'UPSTREAM_REFUSED' ? 'frame unavailable' : 'upstream unavailable');
      else res.destroy();
    } finally {
      this.active--;
    }
  }

  private async serveSnapshot(entry: Entry, res: ServerResponse, head: boolean, signal: AbortSignal): Promise<void> {
    const headers = await entry.camera.headers();
    const r = await this.opts.fetchBytes(entry.camera.url, {
      maxBytes: MAX_FRAME_BYTES,
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'image/jpeg,image/png', ...headers },
      signal,
    });
    const bad = errorForStatus(r.status);
    if (bad) throw bad;
    const type = assertImage(r.bytes);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(r.bytes.byteLength) });
    if (head) {
      res.end();
      return;
    }
    res.end(r.bytes);
    this.logger.debug('relay served snapshot', { cameraId: entry.camera.cameraId, bytes: r.bytes.byteLength });
  }

  private async servePlaylist(
    entry: Entry,
    playlistUrl: string,
    res: ServerResponse,
    head: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const headers = await entry.camera.headers();
    const r = await this.opts.fetchBytes(playlistUrl, {
      maxBytes: MAX_PLAYLIST_BYTES,
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*', ...headers },
      signal,
    });
    const bad = errorForStatus(r.status);
    if (bad) throw bad;
    const text = new TextDecoder().decode(r.bytes);
    if (!text.trimStart().startsWith('#EXTM3U'))
      throw new CameraError('UPSTREAM_ERROR', 'upstream body is not an HLS playlist', { retryable: false });
    const prefix = this.urlFor(entry.camera.cameraId);
    if (!prefix || !entry.hls) throw new CameraError('UNAVAILABLE', 'relay not listening');
    const body = Buffer.from(rewritePlaylist(text, playlistUrl, entry.hls, prefix), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(body.byteLength) });
    res.end(head ? undefined : body);
  }

  private async pipeUpstream(
    entry: Entry,
    target: string,
    res: ServerResponse,
    head: boolean,
    signal: AbortSignal,
    isClosed: () => boolean,
    /** A whole stream (not an HLS segment): its opening and end are logged, for "why did the video stop". */
    whole = false,
  ): Promise<void> {
    const headers = await entry.camera.headers();
    const startedAt = Date.now();
    const upstream = await this.opts.openUpstream(target, { headers, signal, timeoutMs: this.timeoutMs });
    const bad = errorForStatus(upstream.status);
    if (bad) {
      upstream.cancel();
      throw bad;
    }
    const contentType = upstream.headers['content-type'] ?? 'application/octet-stream';
    if (!STREAM_CONTENT_TYPES.test(contentType)) {
      upstream.cancel();
      throw new CameraError('UPSTREAM_ERROR', `upstream content-type ${contentType.split(';')[0]} is not media`, {
        retryable: false,
      });
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {}),
    });
    if (head) {
      upstream.cancel();
      res.end();
      return;
    }
    const mediaType = contentType.split(';')[0]!.trim().toLowerCase().slice(0, 60);
    if (whole)
      this.logger.info('relay stream opened', { cameraId: entry.camera.cameraId, kind: entry.camera.kind, mediaType });
    let bytes = 0;
    let endedBy: 'client' | 'upstream' = 'upstream';
    try {
      for await (const chunk of upstream.body) {
        if (isClosed()) {
          endedBy = 'client';
          break;
        }
        bytes += chunk.byteLength;
        if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    } finally {
      upstream.cancel();
    }
    if (isClosed()) endedBy = 'client';
    res.end();
    const fields = { cameraId: entry.camera.cameraId, bytes, ms: Date.now() - startedAt, endedBy };
    if (whole) this.logger.info('relay stream ended', fields);
    else this.logger.debug('relay stream ended', fields);
  }
}

function defaultToken(): string {
  return randomBytes(16).toString('hex');
}

function tokensEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function decodeRel(rel: string): string {
  return rel
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

function plain(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function statusFor(err: CameraError): number {
  switch (err.code) {
    case 'NOT_FOUND':
      return 404;
    case 'TIMEOUT':
      return 504;
    case 'UNAVAILABLE':
      return 503;
    default:
      return 502;
  }
}
