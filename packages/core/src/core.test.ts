import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpClient,
  LoggerHub,
  RingBufferSink,
  redactText,
  redactFields,
  RateLimiter,
  CircuitBreaker,
  SingleFlight,
  backoffDelay,
  TypedEmitter,
  substitutePathCredential,
} from './index.js';
import { ProviderError, testing } from '@worldview/provider-sdk';

const { VirtualClock } = testing;

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}

const noSleep = async () => {};

test('http: rejects hosts outside the allowlist and non-https schemes', async () => {
  const clock = new VirtualClock();
  const client = new HttpClient({
    allowedHosts: ['earthquake.usgs.gov'],
    clock,
    fetchImpl: fakeFetch(() => new Response('{}')),
  });
  await assert.rejects(
    client.request({ url: 'https://evil.example/x' }),
    (e: ProviderError) => e.code === 'HOST_NOT_ALLOWED',
  );
  await assert.rejects(
    client.request({ url: 'http://earthquake.usgs.gov/x' }),
    (e: ProviderError) => e.code === 'HOST_NOT_ALLOWED',
  );
  const ok = await client.request({ url: 'https://earthquake.usgs.gov/feed.json' });
  assert.equal(ok.status, 200);
  const local = new HttpClient({ allowedHosts: ['127.0.0.1'], clock, fetchImpl: fakeFetch(() => new Response('ok')) });
  assert.equal((await local.request({ url: 'http://127.0.0.1:8080/data/aircraft.json' })).text(), 'ok');
});

test('http: size cap is enforced on streamed bodies', async () => {
  const clock = new VirtualClock();
  const big = 'x'.repeat(10_000);
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    fetchImpl: fakeFetch(() => new Response(big)),
    maxRetries: 0,
  });
  await assert.rejects(
    client.request({ url: 'https://a.example/big', maxBytes: 1000 }),
    (e: ProviderError) => e.code === 'TOO_LARGE',
  );
});

test('http: ETag conditional requests serve cached body on 304', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  let lastHeaders: Headers | undefined;
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    fetchImpl: fakeFetch((_u, init) => {
      calls++;
      lastHeaders = new Headers(init.headers as Record<string, string>);
      if (lastHeaders.get('if-none-match') === '"v1"') return new Response(null, { status: 304 });
      return new Response('{"v":1}', { status: 200, headers: { etag: '"v1"' } });
    }),
  });
  const r1 = await client.request({ url: 'https://a.example/feed' });
  assert.equal(r1.fromCache, false);
  const r2 = await client.request({ url: 'https://a.example/feed' });
  assert.equal(r2.fromCache, true);
  assert.equal(r2.text(), '{"v":1}');
  assert.equal(calls, 2);
  assert.equal(client.stats.notModified, 1);
});

test('http: retries 5xx with backoff, gives up after maxRetries, opens circuit, serves stale within window', async () => {
  const clock = new VirtualClock();
  let mode: 'ok' | 'fail' = 'ok';
  let calls = 0;
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    maxRetries: 2,
    sleep: noSleep,
    staleWhileErrorMs: 60_000,
    fetchImpl: fakeFetch(() => {
      calls++;
      return mode === 'ok' ? new Response('good') : new Response('bad', { status: 503 });
    }),
  });
  assert.equal((await client.request({ url: 'https://a.example/f' })).text(), 'good');
  mode = 'fail';
  calls = 0;
  const stale = await client.request({ url: 'https://a.example/f' });
  assert.equal(stale.stale, true);
  assert.equal(stale.text(), 'good');
  assert.equal(calls, 3, 'initial + 2 retries');
  // Circuit: after 3 consecutive failures (one call = 3 attempts) the breaker opens.
  calls = 0;
  const stale2 = await client.request({ url: 'https://a.example/f' });
  assert.equal(stale2.stale, true);
  assert.equal(calls, 0, 'circuit open: no upstream call');
  // Outside the stale window the failure surfaces.
  clock.advance(120_000);
  clock.advance(10 * 60_000);
  await assert.rejects(client.request({ url: 'https://a.example/f' }), (e: ProviderError) => e.code === 'HTTP_5XX');
});

test('http: 429 maps to RATE_LIMITED with retry-after and is not retried', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    maxRetries: 3,
    sleep: noSleep,
    fetchImpl: fakeFetch(() => {
      calls++;
      return new Response('', { status: 429, headers: { 'retry-after': '30' } });
    }),
  });
  await assert.rejects(
    client.request({ url: 'https://a.example/f' }),
    (e: ProviderError) => e.code === 'RATE_LIMITED' && e.retryAfterMs === 30_000,
  );
  assert.equal(calls, 1);
});

test('http: timeout and cancellation are classified', async () => {
  const clock = new VirtualClock();
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    maxRetries: 0,
    fetchImpl: fakeFetch(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
        }),
    ),
  });
  await assert.rejects(
    client.request({ url: 'https://a.example/slow', timeoutMs: 20 }),
    (e: ProviderError) => e.code === 'TIMEOUT',
  );
  const ac = new AbortController();
  const p = client.request({ url: 'https://a.example/slow2', timeoutMs: 10_000, signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e: ProviderError) => e.code === 'CANCELLED');
});

test('http: identical concurrent requests are coalesced', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    fetchImpl: fakeFetch(async () => {
      calls++;
      await gate;
      return new Response('x');
    }),
  });
  const a = client.request({ url: 'https://a.example/f' });
  const b = client.request({ url: 'https://a.example/f' });
  release!();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(client.stats.coalesced, 1);
});

test('http: credential injected by key, never exposed in errors; offline fails fast', async () => {
  const clock = new VirtualClock();
  let seenUrl = '';
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    maxRetries: 0,
    credentials: { get: async (k) => (k === 'firms.mapKey' ? 'SECRET123' : undefined) },
    fetchImpl: fakeFetch((u) => {
      seenUrl = u;
      return new Response('', { status: 500 });
    }),
  });
  await assert.rejects(
    client.request({ url: 'https://a.example/api', credential: { key: 'firms.mapKey', as: 'query', name: 'MAP_KEY' } }),
    (e: ProviderError) => e.code === 'HTTP_5XX' && !e.message.includes('SECRET123'),
  );
  assert.ok(seenUrl.includes('MAP_KEY=SECRET123'));
  await assert.rejects(
    client.request({ url: 'https://a.example/api', credential: { key: 'missing', as: 'header' } }),
    (e: ProviderError) => e.code === 'AUTH',
  );
  const offline = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    online: () => false,
    fetchImpl: fakeFetch(() => new Response('x')),
  });
  await assert.rejects(offline.request({ url: 'https://a.example/api' }), (e: ProviderError) => e.code === 'OFFLINE');
});

test('http: credential as "path" substitutes the percent-encoded secret into the path only (ADR-003)', async () => {
  const clock = new VirtualClock();
  const seen: string[] = [];
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    maxRetries: 0,
    cacheEnabled: false,
    credentials: { get: async (k) => (k === 'firms.mapKey' ? 'se/cr et+1' : undefined) },
    fetchImpl: fakeFetch((u) => {
      seen.push(u);
      return new Response('ok', { status: 200 });
    }),
  });

  // The placeholder lives in the path; the secret is encoded per segment so it can
  // never introduce a new path segment, a query parameter or a fragment.
  const res = await client.request({
    url: 'https://a.example/api/area/csv/{MAP_KEY}/VIIRS/world/1?format=csv',
    credential: { key: 'firms.mapKey', as: 'path', name: 'MAP_KEY' },
    cacheKey: 'GET placeholder',
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0], 'https://a.example/api/area/csv/se%2Fcr%20et%2B1/VIIRS/world/1?format=csv');
  assert.ok(!seen[0]!.includes('{MAP_KEY}'));

  // The default placeholder name is {TOKEN}.
  await client.request({
    url: 'https://a.example/v1/{TOKEN}/feed',
    credential: { key: 'firms.mapKey', as: 'path' },
    cacheKey: 'GET token',
  });
  assert.equal(seen[1], 'https://a.example/v1/se%2Fcr%20et%2B1/feed');

  // A missing placeholder is a programming error, not a silent unauthenticated request.
  await assert.rejects(
    client.request({
      url: 'https://a.example/v1/feed?MAP_KEY={MAP_KEY}',
      credential: { key: 'firms.mapKey', as: 'path', name: 'MAP_KEY' },
      cacheKey: 'GET noplaceholder',
    }),
    (e: ProviderError) => e.code === 'INTERNAL' && /placeholder \{MAP_KEY\} is not present/.test(e.message),
  );
  assert.equal(seen.length, 2, 'no request left the client without the credential in place');
});

test('substitutePathCredential encodes the secret and refuses a placeholder outside the path', () => {
  assert.equal(substitutePathCredential('https://h.example/a/{K}/b', 'K', 'x y/z'), 'https://h.example/a/x%20y%2Fz/b');
  assert.equal(substitutePathCredential('https://h.example/{K}/{K}', 'K', 'ab'), 'https://h.example/ab/ab');
  assert.throws(
    () => substitutePathCredential('https://h.example/a?k={K}', 'K', 'ab'),
    /placeholder \{K\} is not present/,
  );
  assert.throws(
    () => substitutePathCredential('https://h.example/a#{K}', 'K', 'ab'),
    /placeholder \{K\} is not present/,
  );
});

test('logger redacts secrets in messages and fields', () => {
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink], now: () => 0 });
  const log = hub.logger('provider', { providerId: 'x' });
  log.info('fetching https://api.example/data?MAP_KEY=abc123&x=1', {
    apiKey: 'zzz',
    nested: { authorization: 'Bearer q' },
    url: 'rtsp://user:pw@cam.local/stream',
  });
  const r = sink.records[0]!;
  assert.ok(!r.message.includes('abc123'));
  assert.equal(r.fields?.apiKey, '<redacted>');
  assert.equal((r.fields?.nested as Record<string, string>).authorization, '<redacted>');
  assert.ok(!(r.fields?.url as string).includes('pw@'));
  assert.equal(r.fields?.providerId, 'x');
  assert.equal(redactText('Authorization: Bearer abc.def'), 'Authorization: Bearer <redacted>');
  assert.deepEqual(redactFields({ token: 't', ok: 1 }), { token: '<redacted>', ok: 1 });
});

test('resilience primitives', async () => {
  const clock = new VirtualClock();
  const rl = new RateLimiter({ windowMs: 1000, max: 2 }, clock);
  assert.equal(rl.tryAcquire('h'), 0);
  assert.equal(rl.tryAcquire('h'), 0);
  assert.ok(rl.tryAcquire('h') > 0);
  clock.advance(1001);
  assert.equal(rl.tryAcquire('h'), 0);

  const cb = new CircuitBreaker({ failureThreshold: 2, openMs: 1000, maxOpenMs: 4000 }, clock);
  assert.equal(cb.allow(), true);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state(), 'open');
  assert.equal(cb.allow(), false);
  clock.advance(1000);
  assert.equal(cb.state(), 'half-open');
  assert.equal(cb.allow(), true, 'one probe allowed');
  assert.equal(cb.allow(), false, 'second probe blocked');
  cb.recordFailure();
  assert.equal(cb.state(), 'open');
  assert.ok(cb.retryInMs() > 1000, 'open window doubled');
  clock.advance(2000);
  assert.equal(cb.allow(), true);
  cb.recordSuccess();
  assert.equal(cb.state(), 'closed');

  const sf = new SingleFlight<number>();
  let n = 0;
  const mk = () => sf.run('k', async () => ++n);
  const [a, b] = [mk(), mk()];
  assert.equal(b.shared, true);
  assert.equal(await a.promise, await b.promise);
  assert.equal(n, 1);

  assert.equal(backoffDelay(0, { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0 }), 100);
  assert.equal(backoffDelay(10, { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0 }), 1000);

  const em = new TypedEmitter<{ tick: number }>();
  let got = 0;
  const off = em.on('tick', (v) => {
    got += v;
  });
  em.emit('tick', 2);
  off();
  em.emit('tick', 5);
  assert.equal(got, 2);
});

test('http: a stale serve says whose rate limit it was', async () => {
  // Both our own limiter and an upstream 429 surface as RATE_LIMITED, and both are answered
  // by serving the cache — so the log line that reports it has to carry the difference, or
  // a provider's stale-serve count cannot be read. It was misread: a count of stale serves
  // was taken as the provider throttling itself when nothing in the line could say so.
  const clock = new VirtualClock();
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink], now: () => 0 });
  const stale = () =>
    sink.records.filter((r) => r.message === 'serving stale response after failure').map((r) => r.fields);

  // Upstream says 429.
  let upstream: 'ok' | '429' = 'ok';
  const a = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    sleep: noSleep,
    staleWhileErrorMs: 60_000,
    logger: hub.logger('provider', { providerId: 'a' }),
    fetchImpl: fakeFetch(() => (upstream === 'ok' ? new Response('good') : new Response('', { status: 429 }))),
  });
  await a.request({ url: 'https://a.example/f' });
  upstream = '429';
  assert.equal((await a.request({ url: 'https://a.example/f' })).stale, true);
  assert.equal(stale().at(-1)?.['httpStatus'], 429, 'upstream throttled us');

  // Our own limiter refuses before anything is sent.
  const b = new HttpClient({
    allowedHosts: ['b.example'],
    clock,
    sleep: noSleep,
    staleWhileErrorMs: 60_000,
    requestsPerMinute: 1,
    logger: hub.logger('provider', { providerId: 'b' }),
    fetchImpl: fakeFetch(() => new Response('good')),
  });
  await b.request({ url: 'https://b.example/f' });
  assert.equal((await b.request({ url: 'https://b.example/f', allowStale: true })).stale, true);
  const own = stale().at(-1);
  assert.equal(own?.['code'], 'RATE_LIMITED');
  assert.equal(own?.['httpStatus'], null, 'our own limiter: nothing was sent, so there is no status');
});

test('http: after a 429 the host is not asked again until its Retry-After has passed', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  let status = 200;
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    sleep: noSleep,
    staleWhileErrorMs: 10 * 60_000,
    fetchImpl: fakeFetch(() => {
      calls++;
      return status === 200
        ? new Response('good')
        : new Response('', { status: 429, headers: { 'retry-after': '30' } });
    }),
  });
  await client.request({ url: 'https://a.example/f' });
  status = 429;
  assert.equal((await client.request({ url: 'https://a.example/f' })).stale, true);
  assert.equal(calls, 2);
  // The provider polls again ten seconds later: served from the cache, nothing sent.
  clock.advance(10_000);
  const held = await client.request({ url: 'https://a.example/f' });
  assert.equal(held.stale, true);
  assert.equal(calls, 2, 'no request inside the Retry-After window');
  // Past the window, it asks again.
  status = 200;
  clock.advance(21_000);
  const fresh = await client.request({ url: 'https://a.example/f' });
  assert.equal(fresh.stale, false);
  assert.equal(calls, 3);
});

test('http: after a 429 the host is paced — the refused gap doubles, and narrows again on success', async () => {
  // adsb.lol on the operator's machine: a ten-second poll, 429 every ninety seconds or so.
  // Waiting out Retry-After and then resuming at full rate is what produced that cycle.
  const clock = new VirtualClock();
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ level: 'debug', sinks: [sink], now: () => clock.now() });
  let calls = 0;
  let status = 200;
  const slept: number[] = [];
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
    staleWhileErrorMs: 120_000,
    logger: hub.logger('provider', { providerId: 'a' }),
    fetchImpl: fakeFetch(() => {
      calls++;
      return status === 200 ? new Response('good') : new Response('', { status: 429, headers: { 'retry-after': '5' } });
    }),
  });
  const url = 'https://a.example/f';
  await client.request({ url });
  assert.equal(client.paceMs('a.example'), undefined, 'a host that never refused is not paced');

  clock.advance(10_000);
  status = 429;
  assert.equal((await client.request({ url })).stale, true);
  assert.equal(calls, 2);
  assert.equal(client.paceMs('a.example'), 20_000, 'refused at a 10 s gap: keep 20 s');

  // Ten seconds on, Retry-After (5 s) has passed but the pace has not: nothing is sent.
  status = 200;
  clock.advance(10_000);
  const held = await client.request({ url });
  assert.equal(held.stale, true);
  assert.equal(calls, 2, 'inside the gap, answered from the cache');
  assert.equal(client.stats.paced, 1);
  const pacedLine = sink.records.filter((r) => r.message === 'serving stale response after failure').at(-1);
  assert.equal(pacedLine?.level, 'debug', 'pacing is chosen, not a failure, so it is not a warning');
  assert.match(String(pacedLine?.fields?.['reason']), /pacing a\.example/);

  // At the end of the gap the request goes out, and the success narrows the gap.
  clock.advance(10_000);
  assert.equal((await client.request({ url })).stale, false);
  assert.equal(calls, 3);
  assert.equal(client.paceMs('a.example'), 19_000);

  // A poll arriving a second before the gap ends waits that second instead of being refused.
  clock.advance(18_000);
  assert.equal((await client.request({ url })).stale, false);
  assert.equal(calls, 4);
  assert.equal(slept.at(-1), 1_000);

  // Enough successes and the host is no longer paced at all.
  for (let i = 0; i < 200 && client.paceMs('a.example') !== undefined; i++) {
    clock.advance(client.paceMs('a.example') ?? 0);
    await client.request({ url });
  }
  assert.equal(client.paceMs('a.example'), undefined);
});

test('http: pacing doubles on repeated refusals and is capped at two minutes', async () => {
  const clock = new VirtualClock();
  const client = new HttpClient({
    allowedHosts: ['a.example'],
    clock,
    sleep: noSleep,
    staleWhileErrorMs: 60 * 60_000,
    fetchImpl: fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '1' } })),
  });
  const url = 'https://a.example/f';
  await assert.rejects(client.request({ url }), /429/);
  assert.equal(client.paceMs('a.example'), 2_000, 'no earlier request: from the 1 s floor');
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    clock.advance(client.paceMs('a.example') ?? 0);
    await assert.rejects(client.request({ url }), /429/);
    seen.push(client.paceMs('a.example') ?? 0);
  }
  assert.deepEqual(seen.slice(0, 6), [4_000, 8_000, 16_000, 32_000, 64_000, 120_000]);
  assert.equal(Math.max(...seen), 120_000);
});

test('logger: a repeating warning is written once, then summarised once per window', async () => {
  let now = Date.parse('2026-09-23T04:00:00Z');
  const sink = new RingBufferSink();
  const hub = new LoggerHub({ sinks: [sink], now: () => now, repeatWindowMs: 60_000 });
  const readsb = hub.logger('provider', { providerId: 'readsb-local' });
  const firms = hub.logger('provider', { providerId: 'nasa-firms' });
  const app = hub.logger('app');

  for (let i = 1; i <= 5; i++) {
    readsb.warn('poll failed', { code: 'OFFLINE', consecutiveFailures: i });
    now += 10_000;
  }
  firms.warn('poll failed', { code: 'OFFLINE' });
  readsb.warn('poll failed', { code: 'MALFORMED', consecutiveFailures: 6 });
  app.error('boom');
  app.error('boom');
  const lines = () => sink.records.map((r) => `${r.level} ${r.message} ${r.fields?.['providerId'] ?? ''}`);
  assert.deepEqual(
    lines(),
    [
      'warn poll failed readsb-local',
      'warn poll failed nasa-firms',
      'warn poll failed readsb-local',
      'error boom ',
      'error boom ',
    ],
    'another provider, another code and errors are not collapsed',
  );

  // The window closes; the next record of any kind brings the summary out first.
  now += 20_000;
  app.info('tick');
  const summary = sink.records.at(-2);
  assert.equal(summary?.message, 'poll failed');
  assert.equal(summary?.fields?.['repeated'], 4);
  assert.equal(summary?.fields?.['consecutiveFailures'], 5, 'the last one’s fields');
  assert.equal(summary?.fields?.['firstRepeatAt'], '2026-09-23T04:00:10.000Z');
  assert.equal(summary?.fields?.['lastRepeatAt'], '2026-09-23T04:00:40.000Z');
  assert.equal(sink.records.at(-1)?.message, 'tick');

  // After the summary the warning is written in full again, starting a new window.
  readsb.warn('poll failed', { code: 'OFFLINE', consecutiveFailures: 7 });
  assert.equal(sink.records.at(-1)?.fields?.['consecutiveFailures'], 7);
  readsb.warn('poll failed', { code: 'OFFLINE', consecutiveFailures: 8 });
  assert.equal(sink.records.at(-1)?.fields?.['consecutiveFailures'], 7, 'counted, not written');
  // Flushing (shutdown) writes what is pending.
  await hub.flush();
  assert.equal(sink.records.at(-1)?.fields?.['repeated'], 1);
  assert.equal(sink.records.at(-1)?.fields?.['consecutiveFailures'], 8);

  // Off unless asked for.
  const plain = new RingBufferSink();
  const hub2 = new LoggerHub({ sinks: [plain] });
  hub2.logger('app').warn('same');
  hub2.logger('app').warn('same');
  assert.equal(plain.records.length, 2);
});
