import type { IsoTimestamp } from '@worldview/world-model';

export type ProviderStatus =
  | 'DISABLED'
  | 'STARTING'
  | 'LIVE'
  | 'DEGRADED'
  | 'STALE'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'OFFLINE'
  | 'ERROR';

export type CredentialState = 'not-required' | 'missing' | 'present' | 'invalid';

export interface RateLimitState {
  limited: boolean;
  /** When the client-side or server-declared limit resets (UTC ISO). */
  resetAt?: IsoTimestamp;
  /** Remaining requests if the upstream reports it. */
  remaining?: number;
}

export interface ProviderHealth {
  providerId: string;
  status: ProviderStatus;
  lastAttempt?: IsoTimestamp;
  lastSuccess?: IsoTimestamp;
  lastObservation?: IsoTimestamp;
  /** Last successful request latency in ms. */
  latencyMs?: number;
  /** Rolling error rate 0..1 over the recent window. */
  errorRate: number;
  /** Age of the data currently being served, in ms (0 when fresh live data). */
  cacheAgeMs?: number;
  rateLimitState: RateLimitState;
  credentialState: CredentialState;
  /** Human-readable, never contains secrets. */
  message?: string;
  /** Structured last error (sanitized). */
  lastError?: ProviderErrorInfo;
  /** Objects currently sourced from this provider. */
  objectCount?: number;
}

export type ProviderErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'DNS'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'MALFORMED'
  | 'TOO_LARGE'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'OFFLINE'
  | 'HOST_NOT_ALLOWED'
  | 'INTERNAL';

export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  message: string;
  httpStatus?: number;
  retryAfterMs?: number;
  at: IsoTimestamp;
}

/** Structured provider error. Providers throw these; the runtime maps them to health states. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { httpStatus?: number; retryAfterMs?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? defaultRetryable(code);
  }

  toInfo(at: IsoTimestamp): ProviderErrorInfo {
    const info: ProviderErrorInfo = { code: this.code, message: sanitizeMessage(this.message), at };
    if (this.httpStatus !== undefined) info.httpStatus = this.httpStatus;
    if (this.retryAfterMs !== undefined) info.retryAfterMs = this.retryAfterMs;
    return info;
  }
}

function defaultRetryable(code: ProviderErrorCode): boolean {
  switch (code) {
    case 'NETWORK':
    case 'TIMEOUT':
    case 'DNS':
    case 'HTTP_5XX':
    case 'RATE_LIMITED':
    case 'OFFLINE':
      return true;
    default:
      return false;
  }
}

const SECRET_PATTERNS = [
  /([?&](?:key|api_key|apikey|token|access_token|map_key|password|pwd|secret)=)[^&\s]+/gi,
  /(authorization:\s*)(bearer\s+)?[^\s]+/gi,
  /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,
];

/** Remove anything that looks like a credential from an error message. */
export function sanitizeMessage(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, prefix: string) => `${prefix}<redacted>`);
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError')
    return new ProviderError('CANCELLED', 'cancelled', { cause: err });
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'TimeoutError')
    return new ProviderError('TIMEOUT', 'timed out', { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message))
    return new ProviderError('DNS', sanitizeMessage(message), { cause: err });
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network/i.test(message))
    return new ProviderError('NETWORK', sanitizeMessage(message), { cause: err });
  return new ProviderError('INTERNAL', sanitizeMessage(message), { cause: err });
}
