import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, type ProviderError } from '@worldview/provider-sdk';
import { ReadsbLocalProvider, DEFAULT_READSB_ENDPOINT, PROBE_BACKOFF_MS } from '../../src/index.js';

const NOW_S = Date.UTC(2026, 8, 21, 8, 0, 0) / 1000;
const feed = (rows: unknown[], now = NOW_S) => JSON.stringify({ now, messages: 10, aircraft: rows });
const oneRow = [{ hex: 'a12b34', lat: 21.37, lon: -157.74, alt_baro: 12000, seen_pos: 0.3 }];
const signal = () => new AbortController().signal;

function setup(
  opts: { reachable?: Record<string, number>; settings?: Record<string, string>; body?: () => string } = {},
) {
  const p = new ReadsbLocalProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'readsb-local',
    clock: new testing.VirtualClock(NOW_S * 1000 + 5000),
    local: new testing.FixtureLocalAccess({}, opts.reachable ?? {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
    responder: () => ({ status: 200, body: (opts.body ?? (() => feed(oneRow)))() }),
  });
  return { p, ctx };
}

test('detection: endpoint not reachable → OFFLINE "readsb not detected", 30 s backoff, no HTTP request, no other host probed', async () => {
  const { p, ctx } = setup();
  await p.initialize(ctx);
  await p.start();
  await assert.rejects(
    p.query({ signal: signal(), background: true }),
    (e: ProviderError) =>
      e.code === 'OFFLINE' &&
      e.message === `readsb not detected at ${DEFAULT_READSB_ENDPOINT}` &&
      e.retryAfterMs === PROBE_BACKOFF_MS,
  );
  assert.equal(ctx.http.requests.length, 0);
  const h = await p.health();
  assert.equal(h.status, 'OFFLINE');
  assert.equal(h.message, `readsb not detected at ${DEFAULT_READSB_ENDPOINT}`);
  assert.equal(p.detectionState, 'not-detected');
  // Inside the backoff window the endpoint is not probed again; the remaining wait is reported.
  ctx.clock.advance(10_000);
  await assert.rejects(
    p.query({ signal: signal(), background: true }),
    (e: ProviderError) => e.code === 'OFFLINE' && e.retryAfterMs === PROBE_BACKOFF_MS - 10_000,
  );
});

test('detection: receiver appears after the backoff → polls succeed, health LIVE with local origin', async () => {
  const reachable: Record<string, number> = {};
  const { p, ctx } = setup({ reachable });
  await p.initialize(ctx);
  await p.start();
  await assert.rejects(p.query({ signal: signal(), background: true }), (e: ProviderError) => e.code === 'OFFLINE');
  reachable[DEFAULT_READSB_ENDPOINT] = 200;
  ctx.clock.advance(PROBE_BACKOFF_MS);
  const obs = await p.query({ signal: signal(), background: true });
  assert.equal(obs.length, 1);
  assert.equal(obs[0]?.provenance.origin, 'local');
  assert.equal(obs[0]?.quality.sourceQuality, 'authoritative');
  assert.equal(p.detectionState, 'detected');
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.message, undefined);
  assert.equal(ctx.http.requests[0]?.url, DEFAULT_READSB_ENDPOINT);
});

test('detection: a transport failure while detected triggers a re-probe before the next poll', async () => {
  const reachable: Record<string, number> = { [DEFAULT_READSB_ENDPOINT]: 200 };
  let fail = false;
  const p = new ReadsbLocalProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'readsb-local',
    clock: new testing.VirtualClock(NOW_S * 1000 + 5000),
    local: new testing.FixtureLocalAccess({}, reachable),
    responder: () => (fail ? { error: 'network' } : { status: 200, body: feed(oneRow) }),
  });
  await p.initialize(ctx);
  await p.start();
  await p.query({ signal: signal(), background: true });
  assert.equal(p.detectionState, 'detected');
  fail = true;
  await assert.rejects(p.query({ signal: signal(), background: true }), (e: ProviderError) => e.code === 'NETWORK');
  assert.equal(p.detectionState, 'unknown');
  // readsb stopped: the probe now fails and the provider backs off instead of hammering.
  delete reachable[DEFAULT_READSB_ENDPOINT];
  await assert.rejects(p.query({ signal: signal(), background: true }), (e: ProviderError) => e.code === 'OFFLINE');
  assert.equal((await p.health()).status, 'OFFLINE');
  assert.equal(ctx.http.requests.length, 2, 'no request issued while not detected');
});

test('settings: a non-loopback endpoint without trustedHost is refused with a clear health message; trustedHost unlocks it', async () => {
  const reachable = { 'http://piaware.lan/data/aircraft.json': 200 };
  const { p, ctx } = setup({ reachable, settings: { endpoint: 'http://piaware.lan/data/aircraft.json' } });
  await p.initialize(ctx);
  await p.start();
  await assert.rejects(
    p.query({ signal: signal(), background: true }),
    (e: ProviderError) => e.code === 'HOST_NOT_ALLOWED' && /set trustedHost to "piaware.lan"/.test(e.message),
  );
  const h = await p.health();
  assert.equal(h.status, 'ERROR');
  assert.match(h.message ?? '', /not loopback/);
  ctx.settings.update({ endpoint: 'http://piaware.lan/data/aircraft.json', trustedHost: 'piaware.lan' });
  const obs = await p.query({ signal: signal(), background: true });
  assert.equal(obs.length, 1);
  assert.equal((await p.health()).status, 'LIVE');
});

test('normalization: the bundled aircraft.json fixture yields 8 observations, Mode S rows without position are not errors', async () => {
  const fixture = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'fixtures',
      'readsb-local',
      'aircraft.json',
    ),
    'utf8',
  );
  const { p, ctx } = setup({ reachable: { [DEFAULT_READSB_ENDPOINT]: 200 }, body: () => fixture });
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: signal(), background: true });
  assert.equal(obs.length, 8);
  assert.equal(p.receiverMessageCount, 1284413);
  assert.equal(
    ctx.logger.entries.filter((e) => e.level === 'warn').length,
    0,
    'missing-position rows are not warnings',
  );
});
