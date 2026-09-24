import { CameraError, toCameraError } from './errors.js';
import type { ByteFetcher, UpstreamOpener, UpstreamStream } from './types.js';

/**
 * Production adapters over the platform `fetch` (undici in Node/Electron main).
 * Both refuse redirects (a camera URL that redirects is treated as an upstream error,
 * so a registered URL can never be steered to another host; the hub alone may follow
 * one, re-checked against the camera's own frame allowlist) and honour the caller's
 * timeout and size caps. Tests inject fakes and never touch these.
 */
export function createFetchByteFetcher(fetchImpl: typeof fetch = fetch): ByteFetcher {
  return async (url, opts) => {
    const { signal, dispose } = withTimeout(opts.timeoutMs, opts.signal);
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: opts.headers ?? {}, redirect: 'manual', signal });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      if (res.status < 200 || res.status >= 300) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        return { status: res.status, headers, bytes: new Uint8Array() };
      }
      const bytes = await readCapped(res, opts.maxBytes, signal);
      return { status: res.status, headers, bytes };
    } catch (err) {
      throw toCameraError(err);
    } finally {
      dispose();
    }
  };
}

export function createFetchUpstreamOpener(fetchImpl: typeof fetch = fetch): UpstreamOpener {
  return async (url, opts) => {
    // The timeout covers connection + headers; the body is a live stream and is cancelled by the caller.
    const { signal, dispose } = withTimeout(opts.timeoutMs, opts.signal);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: opts.headers ?? {}, redirect: 'manual', signal });
    } catch (err) {
      dispose();
      throw toCameraError(err);
    }
    dispose();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = res.body;
    const stream: UpstreamStream = {
      status: res.status,
      headers,
      body: body
        ? iterate(body, opts.signal)
        : (async function* () {
            /* empty */
          })(),
      cancel: () => {
        // While `iterate` holds its reader the stream is locked and `cancel()` rejects (it is
        // the reader's `cancel`, in iterate's `finally`, that closes it then). Unawaited, that
        // rejection surfaced as an unhandled "ReadableStream is locked" every time a live
        // camera stream or a first-frame snapshot ended.
        try {
          if (body && !body.locked) body.cancel().catch(() => undefined);
        } catch {
          /* ignore */
        }
      },
    };
    return stream;
  };
}

async function* iterate(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new CameraError('TOO_LARGE', `content-length ${declared} exceeds ${maxBytes}`, { retryable: false });
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iterate(res.body, signal)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new CameraError('TOO_LARGE', `body exceeded ${maxBytes} bytes`, { retryable: false });
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function withTimeout(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('camera upstream timed out', 'TimeoutError')),
    timeoutMs,
  );
  const onAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}
