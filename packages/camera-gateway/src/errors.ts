import { redactText } from '@worldview/core';

export type CameraErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'UNSUPPORTED'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_REFUSED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'TOO_LARGE'
  | 'NOT_AN_IMAGE'
  | 'CANCELLED'
  | 'INTERNAL';

/**
 * Typed camera error. Messages are redacted at construction so a URL with
 * embedded credentials can never reach a log or the renderer through an error.
 */
export class CameraError extends Error {
  readonly code: CameraErrorCode;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: CameraErrorCode,
    message: string,
    opts: { httpStatus?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(redactText(message), opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CameraError';
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable ?? defaultRetryable(code);
  }

  toInfo(): { code: CameraErrorCode; message: string; httpStatus?: number } {
    return {
      code: this.code,
      message: this.message,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
    };
  }

  /** Suggested IPC error code for the runtime's `camera.*` handlers. */
  get ipcCode(): 'INVALID_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INTERNAL' | 'CANCELLED' {
    switch (this.code) {
      case 'INVALID_URL':
      case 'UNSUPPORTED_SCHEME':
      case 'UNSUPPORTED':
        return 'INVALID_REQUEST';
      case 'NOT_FOUND':
        return 'NOT_FOUND';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'INTERNAL':
        return 'INTERNAL';
      default:
        return 'UNAVAILABLE';
    }
  }
}

function defaultRetryable(code: CameraErrorCode): boolean {
  return code === 'TIMEOUT' || code === 'NETWORK' || code === 'UPSTREAM_ERROR' || code === 'UNAVAILABLE';
}

export function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'TimeoutError') return new CameraError('TIMEOUT', 'upstream timed out', { cause: err });
  if (name === 'AbortError') return new CameraError('CANCELLED', 'cancelled', { cause: err });
  const message =
    err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}` : String(err);
  if (/timeout|timed out/i.test(message)) return new CameraError('TIMEOUT', 'upstream timed out', { cause: err });
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network/i.test(message))
    return new CameraError('NETWORK', message.slice(0, 200), { cause: err });
  return new CameraError('INTERNAL', message.slice(0, 200), { cause: err });
}

/** Map an upstream HTTP status to a typed error, or undefined when the status is acceptable. */
export function errorForStatus(status: number): CameraError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status >= 300 && status < 400)
    return new CameraError('UPSTREAM_ERROR', `upstream redirect (${status}) not followed`, {
      httpStatus: status,
      retryable: false,
    });
  if (status === 401 || status === 403)
    return new CameraError('UPSTREAM_REFUSED', `upstream refused the request (HTTP ${status})`, {
      httpStatus: status,
      retryable: false,
    });
  if (status === 404)
    return new CameraError('UPSTREAM_ERROR', 'upstream has no such resource (HTTP 404)', {
      httpStatus: status,
      retryable: false,
    });
  if (status === 429)
    return new CameraError('UPSTREAM_ERROR', 'upstream rate limited (HTTP 429)', { httpStatus: status });
  if (status >= 500)
    return new CameraError('UPSTREAM_ERROR', `upstream error (HTTP ${status})`, { httpStatus: status });
  return new CameraError('UPSTREAM_ERROR', `unexpected upstream status ${status}`, {
    httpStatus: status,
    retryable: false,
  });
}
