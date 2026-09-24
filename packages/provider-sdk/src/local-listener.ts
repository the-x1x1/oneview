/**
 * A loopback listener (ADR-003 amendment 2026-09-23, for phase `ingest`): the one thing that
 * listens. A `local-process` provider may ask the host to open an HTTP/1.1 listener on
 * `127.0.0.1` — never another address, never TLS — at one path, and the host hands it every
 * `POST` that carries the bearer token named by credential key. The provider never sees the
 * token: the host compares it. Everything else is refused before the provider is asked:
 * another path (404), another method (405), a missing or wrong token (401), a body over
 * `maxBodyBytes` (413), more than `maxRequestsPerMinute` (429). The listener is tied to the
 * provider's run: the host closes it when the provider stops or is disabled.
 */
export interface LocalListenerOptions {
  /** 1024–65535; the operator's setting. In use → NETWORK, with the port named. */
  port: number;
  /** The one path served, `/`-rooted, no query (`/ingest/<id>`). */
  path: string;
  /** The bearer token, by credential key; compared by the host, never handed to the provider. */
  credential: { key: string };
  /** Default 1 MiB, at most 16 MiB. A larger body is refused before it is read. */
  maxBodyBytes?: number;
  /** Default 600. Past it the pusher gets 429 with a Retry-After. */
  maxRequestsPerMinute?: number;
  signal?: AbortSignal;
}

export interface LocalRequest {
  method: string;
  /** Header names lower-cased; the Authorization header is not among them. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** The pusher's address (always loopback) and port. */
  remote: string;
}

export interface LocalResponse {
  status: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

export type LocalListenerHandler = (request: LocalRequest) => Promise<LocalResponse> | LocalResponse;

export interface LocalListenerHandle {
  readonly port: number;
  /** Requests handed to the provider so far, and those refused before it (by status). */
  readonly received: number;
  readonly refused: Record<number, number>;
  close(): Promise<void>;
}

export const LISTENER_DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const LISTENER_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const LISTENER_DEFAULT_MAX_REQUESTS_PER_MINUTE = 600;
export const LISTENER_MAX_REQUESTS_PER_MINUTE = 6000;
const LISTENER_PATH = /^\/[A-Za-z0-9_./-]{0,255}$/;

/** The options as the host will use them, or what is wrong with them. */
export function checkListenerOptions(
  opts: LocalListenerOptions,
):
  | { ok: true; port: number; path: string; maxBodyBytes: number; maxRequestsPerMinute: number }
  | { ok: false; reason: string } {
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535)
    return { ok: false, reason: `port ${String(opts.port)} is not between 1024 and 65535` };
  if (
    typeof opts.path !== 'string' ||
    !LISTENER_PATH.test(opts.path) ||
    opts.path.includes('..') ||
    opts.path.includes('//')
  )
    return { ok: false, reason: `path ${JSON.stringify(opts.path)} is not a plain /-rooted path` };
  if (!opts.credential?.key) return { ok: false, reason: 'a listener needs a credential (the bearer token)' };
  const maxBodyBytes = opts.maxBodyBytes ?? LISTENER_DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > LISTENER_MAX_BODY_BYTES)
    return {
      ok: false,
      reason: `maxBodyBytes ${String(opts.maxBodyBytes)} is not between 1 and ${LISTENER_MAX_BODY_BYTES}`,
    };
  const maxRequestsPerMinute = opts.maxRequestsPerMinute ?? LISTENER_DEFAULT_MAX_REQUESTS_PER_MINUTE;
  if (
    !Number.isInteger(maxRequestsPerMinute) ||
    maxRequestsPerMinute < 1 ||
    maxRequestsPerMinute > LISTENER_MAX_REQUESTS_PER_MINUTE
  )
    return {
      ok: false,
      reason: `maxRequestsPerMinute ${String(opts.maxRequestsPerMinute)} is not between 1 and ${LISTENER_MAX_REQUESTS_PER_MINUTE}`,
    };
  return { ok: true, port: opts.port, path: opts.path.replace(/\/+$/, '') || '/', maxBodyBytes, maxRequestsPerMinute };
}

/** A refusal decided before the provider is asked, with the status the pusher gets. */
export interface ListenerRefusal {
  status: number;
  reason: string;
  headers?: Record<string, string>;
}

/**
 * The admission rules, shared by the host's listener and `testing.FixtureLocalAccess` so a
 * provider tested against the fixture is refused exactly as it will be in the app. Rate is a
 * sliding minute of accepted requests.
 */
export class ListenerGate {
  private readonly accepted: number[] = [];
  constructor(
    private readonly rules: { path: string; maxBodyBytes: number; maxRequestsPerMinute: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Checks the request line and headers; the body size is checked from `Content-Length`
   * here and again by the caller while it reads. `secret` is the configured token, or
   * undefined when none is (then every request is 401).
   */
  admit(
    req: { method: string; path: string; authorization?: string; contentLength?: number },
    secret: string | undefined,
  ): ListenerRefusal | undefined {
    const path = req.path.split('?')[0]!.replace(/\/+$/, '') || '/';
    if (path !== this.rules.path) return { status: 404, reason: 'not the listener path' };
    if (req.method !== 'POST') return { status: 405, reason: 'only POST', headers: { Allow: 'POST' } };
    if (!secret || !bearerMatches(req.authorization, secret))
      return { status: 401, reason: 'missing or wrong bearer token', headers: { 'WWW-Authenticate': 'Bearer' } };
    if (req.contentLength !== undefined && req.contentLength > this.rules.maxBodyBytes)
      return { status: 413, reason: `the body exceeds ${this.rules.maxBodyBytes} bytes` };
    const t = this.now();
    while (this.accepted.length && t - this.accepted[0]! >= 60_000) this.accepted.shift();
    if (this.accepted.length >= this.rules.maxRequestsPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (t - this.accepted[0]!)) / 1000));
      return {
        status: 429,
        reason: `more than ${this.rules.maxRequestsPerMinute} requests in a minute`,
        headers: { 'Retry-After': String(retryAfter) },
      };
    }
    this.accepted.push(t);
    return undefined;
  }
}

/**
 * `Authorization: Bearer <token>` against the configured token, in time that depends only on
 * the lengths (no early exit on the first differing byte). Plain code, so the SDK stays free
 * of Node imports.
 */
export function bearerMatches(authorization: string | undefined, secret: string): boolean {
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!m) return false;
  const given = new TextEncoder().encode(m[1]!);
  const want = new TextEncoder().encode(secret);
  let diff = given.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= (given[i % Math.max(1, given.length)] ?? 0) ^ want[i]!;
  return diff === 0 && given.length === want.length;
}
