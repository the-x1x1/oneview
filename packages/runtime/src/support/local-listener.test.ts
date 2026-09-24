import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {
  ProviderError,
  bearerMatches,
  checkListenerOptions,
  testing,
  type LocalRequest,
} from '@worldview/provider-sdk';
import { createLocalListener } from './local-listener.js';

/** A port nothing is listening on right now (≥ 1024, as the contract requires). */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    if (port >= 1024) return port;
  }
}

/** One raw request, so the test controls every header (Host included). */
function request(
  port: number,
  opts: {
    method?: string;
    path?: string;
    host?: string;
    token?: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/ingest/probe',
        headers: {
          Host: opts.host ?? `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('listener: loopback only, the path, POST, the bearer token, the Host header; the token and cookies never reach the provider', async () => {
  const port = await freePort();
  let token: string | undefined = 's3cret-token';
  const seen: LocalRequest[] = [];
  const listen = createLocalListener({ resolveSecret: async (key) => (key === 'ingest.token' ? token : undefined) });
  const handle = await listen(
    { port, path: '/ingest/probe', credential: { key: 'ingest.token' }, maxBodyBytes: 256 },
    (req) => {
      seen.push(req);
      return { status: 202, body: JSON.stringify({ accepted: 1 }) };
    },
  );
  assert.equal(handle.port, port);

  const ok = await request(port, {
    token: 's3cret-token',
    body: '{"records":[]}',
    headers: { Cookie: 'a=b', 'User-Agent': 'node-red' },
  });
  assert.equal(ok.status, 202);
  assert.equal(ok.body, '{"accepted":1}');
  assert.equal(seen.length, 1);
  assert.equal(new TextDecoder().decode(seen[0]!.body), '{"records":[]}');
  assert.equal(seen[0]!.headers['user-agent'], 'node-red');
  assert.equal(seen[0]!.headers['authorization'], undefined, 'the token never reaches the provider');
  assert.equal(seen[0]!.headers['cookie'], undefined);

  assert.equal((await request(port, { token: 'wrong', body: '{}' })).status, 401);
  assert.equal((await request(port, { body: '{}' })).status, 401);
  assert.equal((await request(port, { token: 's3cret-token', path: '/elsewhere', body: '{}' })).status, 404);
  const get = await request(port, { token: 's3cret-token', method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers['allow'], 'POST');
  assert.equal(
    (await request(port, { token: 's3cret-token', method: 'OPTIONS' })).status,
    405,
    'no CORS preflight passes',
  );
  assert.equal(
    (await request(port, { token: 's3cret-token', host: `rebound.example:${port}`, body: '{}' })).status,
    421,
    'a DNS-rebound page sends its own Host and is refused',
  );
  assert.equal((await request(port, { token: 's3cret-token', host: 'localhost:1', body: '{}' })).status, 421);
  assert.equal((await request(port, { token: 's3cret-token', body: 'x'.repeat(257) })).status, 413);
  assert.equal(seen.length, 1, 'nothing refused reached the provider');

  // A regenerated token applies to the next request; no token configured refuses everything.
  token = 'rotated';
  assert.equal((await request(port, { token: 's3cret-token', body: '{}' })).status, 401);
  assert.equal((await request(port, { token: 'rotated', body: '{}' })).status, 202);
  token = undefined;
  assert.equal((await request(port, { token: 'rotated', body: '{}' })).status, 401);
  assert.ok((handle.refused[401] ?? 0) >= 4);
  assert.equal(handle.received, 2);

  await handle.close();
  await assert.rejects(request(port, { token: 'rotated', body: '{}' }), /ECONNREFUSED/);
});

test('listener: binds 127.0.0.1 only, refuses bad options, reports a port in use, and rate-limits with Retry-After', async () => {
  const port = await freePort();
  let now = 1_000_000;
  const listen = createLocalListener({ resolveSecret: async () => 't', now: () => now });
  const handle = await listen({ port, path: '/ingest/x', credential: { key: 'k' }, maxRequestsPerMinute: 2 }, () => ({
    status: 202,
  }));
  // The server is on 127.0.0.1, not on every interface: connecting to the host's other
  // addresses is not possible from a test portably, so check the socket's own address.
  const probe = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((r) => probe.once('connect', () => r()));
  assert.equal(probe.remoteAddress, '127.0.0.1');
  probe.destroy();

  assert.equal((await request(port, { path: '/ingest/x', token: 't', body: '{}' })).status, 202);
  assert.equal((await request(port, { path: '/ingest/x', token: 't', body: '{}' })).status, 202);
  const limited = await request(port, { path: '/ingest/x', token: 't', body: '{}' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  now += 61_000;
  assert.equal((await request(port, { path: '/ingest/x', token: 't', body: '{}' })).status, 202, 'a minute later');

  await assert.rejects(
    listen({ port, path: '/ingest/y', credential: { key: 'k' } }, () => ({ status: 202 })),
    (e: unknown) => e instanceof ProviderError && e.code === 'NETWORK' && /already in use/.test(e.message),
  );
  await handle.close();

  for (const bad of [
    { port: 80, path: '/a', credential: { key: 'k' } },
    { port: 70000, path: '/a', credential: { key: 'k' } },
    { port, path: 'relative', credential: { key: 'k' } },
    { port, path: '/a/../b', credential: { key: 'k' } },
    { port, path: '/a', credential: { key: '' } },
    { port, path: '/a', credential: { key: 'k' }, maxBodyBytes: 64 * 1024 * 1024 },
  ])
    await assert.rejects(
      listen(bad, () => ({ status: 202 })),
      (e: unknown) => e instanceof ProviderError && e.code === 'INTERNAL',
      JSON.stringify(bad),
    );
  assert.ok(checkListenerOptions({ port: 47311, path: '/ingest/node-red/', credential: { key: 'k' } }).ok);
  assert.ok(bearerMatches('Bearer abc', 'abc') && bearerMatches('bearer  abc ', 'abc'));
  assert.ok(
    !bearerMatches('Bearer abcd', 'abc') && !bearerMatches('Basic abc', 'abc') && !bearerMatches(undefined, 'abc'),
  );
});

test('fixture listener: the same admission rules as the host, one listener per source, simulateRequest', async () => {
  const local = new testing.FixtureLocalAccess();
  local.listenerSecrets['ingest.token'] = 'tok';
  let now = 0;
  local.now = () => now;
  const got: string[] = [];
  const handle = await local.listen(
    {
      port: 47311,
      path: '/ingest/probe',
      credential: { key: 'ingest.token' },
      maxBodyBytes: 16,
      maxRequestsPerMinute: 2,
    },
    (req) => {
      got.push(new TextDecoder().decode(req.body));
      return { status: 202 };
    },
  );
  await assert.rejects(
    local.listen({ port: 47312, path: '/x', credential: { key: 'ingest.token' } }, () => ({ status: 202 })),
    /one listener per source/,
  );
  assert.equal((await local.simulateRequest({ token: 'tok', body: '{"a":1}' })).status, 202);
  assert.equal((await local.simulateRequest({ token: 'nope', body: '{}' })).status, 401);
  assert.equal((await local.simulateRequest({ token: 'tok', method: 'GET' })).status, 405);
  assert.equal((await local.simulateRequest({ token: 'tok', path: '/other', body: '{}' })).status, 404);
  assert.equal((await local.simulateRequest({ token: 'tok', body: 'x'.repeat(17) })).status, 413);
  assert.equal((await local.simulateRequest({ token: 'tok', body: '{}' })).status, 202);
  assert.equal((await local.simulateRequest({ token: 'tok', body: '{}' })).status, 429);
  now += 60_000;
  assert.equal((await local.simulateRequest({ token: 'tok', body: '{}' })).status, 202);
  assert.deepEqual(got, ['{"a":1}', '{}', '{}']);
  assert.equal(handle.received, 3);
  await handle.close();
  await assert.rejects(local.simulateRequest({ token: 'tok', body: '{}' }), /nothing is listening/);
});
