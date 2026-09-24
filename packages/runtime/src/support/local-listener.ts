import http from 'node:http';
import {
  ListenerGate,
  ProviderError,
  checkListenerOptions,
  type LocalListenerHandle,
  type LocalListenerHandler,
  type LocalListenerOptions,
} from '@worldview/provider-sdk';

/**
 * `ProviderLocalAccess.listen` (ADR-003 amendment 2026-09-23, for phase `ingest`): the one
 * thing WORLDVIEW listens on. An HTTP/1.1 server bound to 127.0.0.1 — the address is fixed
 * here, not taken from the provider — at one path. Before the provider is asked, a request
 * must: come from loopback; name a loopback Host with the listener's port (a page that
 * rebinds a DNS name to 127.0.0.1 sends its own name, and is refused); be a POST to the path;
 * carry the bearer token, compared here against the credential store (the provider never sees
 * it, and a regenerated token applies to the next request); fit `maxBodyBytes`, checked from
 * Content-Length and again while reading; and fit `maxRequestsPerMinute`. The Authorization
 * header is removed before the provider sees the request. No TLS, no keep-alive games, short
 * timeouts. Nothing is written to the log with a header or a body in it.
 */
export interface LocalListenerDeps {
  resolveSecret: (key: string) => Promise<string | undefined>;
  /** Told of each request refused before the provider is asked (the host republishes health). */
  onRefused?: (status: number) => void;
  /** Injectable for tests; defaults to `node:http`'s `createServer`. */
  createServer?: typeof http.createServer;
  now?: () => number;
}

const HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i;

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || a.startsWith('127.');
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'application/json; charset=utf-8' : 'application/octet-stream',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
    Connection: 'close',
    ...headers,
  });
  res.end(bytes);
}

const refusal = (reason: string) => JSON.stringify({ error: reason });

export function createLocalListener(deps: LocalListenerDeps) {
  return async (options: LocalListenerOptions, handler: LocalListenerHandler): Promise<LocalListenerHandle> => {
    const checked = checkListenerOptions(options);
    if (!checked.ok) throw new ProviderError('INTERNAL', `listener refused: ${checked.reason}`, { retryable: false });
    const gate = new ListenerGate(checked, deps.now);
    const refused: Record<number, number> = {};
    let received = 0;
    const refuse = (res: http.ServerResponse, status: number, reason: string, headers?: Record<string, string>) => {
      refused[status] = (refused[status] ?? 0) + 1;
      send(res, status, refusal(reason), headers);
      try {
        deps.onRefused?.(status);
      } catch {
        /* a listener never fails a request over its observer */
      }
    };

    const server = (deps.createServer ?? http.createServer)((req, res) => {
      void (async () => {
        if (!isLoopbackAddress(req.socket.remoteAddress)) return refuse(res, 403, 'loopback only');
        const host = HOST_HEADER.exec(req.headers.host ?? '');
        if (!host || Number(host[2]) !== checked.port)
          return refuse(res, 421, 'the Host header must be 127.0.0.1 or localhost with this port');
        const lengthHeader = req.headers['content-length'];
        const contentLength =
          lengthHeader !== undefined && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
        const verdict = gate.admit(
          {
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
            ...(contentLength !== undefined ? { contentLength } : {}),
          },
          await deps.resolveSecret(options.credential.key).catch(() => undefined),
        );
        if (verdict) {
          req.resume();
          return refuse(res, verdict.status, verdict.reason, verdict.headers);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.byteLength;
          if (size > checked.maxBodyBytes) {
            tooLarge = true;
            break;
          }
          chunks.push(chunk);
        }
        if (tooLarge) {
          refuse(res, 413, `the body exceeds ${checked.maxBodyBytes} bytes`);
          req.destroy();
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers))
          if (k !== 'authorization' && k !== 'cookie' && typeof v === 'string') headers[k] = v;
        received++;
        let answer;
        try {
          answer = await handler({
            method: 'POST',
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
            remote: `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`,
          });
        } catch {
          return send(res, 500, refusal('the source could not take the request'));
        }
        send(res, answer.status, answer.body ?? '', answer.headers ?? {});
      })().catch(() => send(res, 500, refusal('internal error')));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 64;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(
          new ProviderError(
            'NETWORK',
            err.code === 'EADDRINUSE'
              ? `port ${checked.port} is already in use on 127.0.0.1`
              : `could not listen on 127.0.0.1:${checked.port}: ${err.message}`,
            { retryable: err.code !== 'EACCES' },
          ),
        );
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // The address is fixed: loopback, IPv4. A provider cannot choose another.
      server.listen({ port: checked.port, host: '127.0.0.1', exclusive: true });
    });

    let closing: Promise<void> | undefined;
    const handle: LocalListenerHandle = {
      port: checked.port,
      get received() {
        return received;
      },
      refused,
      close: () =>
        (closing ??= new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })),
    };
    options.signal?.addEventListener('abort', () => void handle.close(), { once: true });
    return handle;
  };
}
