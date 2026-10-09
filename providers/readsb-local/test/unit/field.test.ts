import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing, type ProviderError } from '@worldview/provider-sdk';
import { DEFAULT_READSB_ENDPOINT, RECEIVER_PROVENANCE, ReadsbLocalProvider } from '../../src/index.js';

/**
 * What a real receiver does in the field (docs/cyberdeck M3): quiet skies, decoders restarting,
 * half-written files, aircraft heard without a position, the same aircraft twice.
 */
const NOW_S = Date.UTC(2026, 9, 8, 20, 0, 0) / 1000;
const signal = () => new AbortController().signal;
const API = 'http://127.0.0.1:8042/?all';

function setup(body: () => string | { error: string }, endpoint = DEFAULT_READSB_ENDPOINT) {
  const reachable: Record<string, number> = { [endpoint]: 200 };
  const p = new ReadsbLocalProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'readsb-local',
    clock: new testing.VirtualClock(NOW_S * 1000 + 2000),
    local: new testing.FixtureLocalAccess({}, reachable),
    ...(endpoint !== DEFAULT_READSB_ENDPOINT ? { settings: { endpoint } } : {}),
    responder: () => {
      const b = body();
      return typeof b === 'string' ? { status: 200, body: b } : b;
    },
  });
  return { p, ctx, reachable };
}

const row = (hex: string, extra: Record<string, unknown> = {}) => ({
  hex,
  lat: 21.33,
  lon: -157.94,
  alt_baro: 3000,
  seen_pos: 0.5,
  ...extra,
});

test('a quiet sky: an empty aircraft list is a healthy receiver with nothing to show, not an error', async () => {
  const { p, ctx } = setup(() => JSON.stringify({ now: NOW_S, messages: 120, aircraft: [] }));
  await p.initialize(ctx);
  await p.start();
  assert.deepEqual(await p.query({ signal: signal(), background: true }), []);
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(p.receiverMessageCount, 120);
});

test("readsb's own HTTP API (--net-api-port, /?all) is read like aircraft.json", async () => {
  const body = JSON.stringify({ now: NOW_S + 0.25, aircraft: [row('a1b2c3')], resultCount: 1, ptime: 0.013 });
  const { p, ctx } = setup(() => body, API);
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: signal(), background: true });
  assert.equal(obs.length, 1);
  assert.equal(obs[0]?.provenance.sourceRef, API);
});

test('every observation says it was received here on 1090 MHz', async () => {
  const { p, ctx } = setup(() => JSON.stringify({ now: NOW_S, aircraft: [row('a1b2c3')] }));
  await p.initialize(ctx);
  await p.start();
  const [o] = await p.query({ signal: signal(), background: true });
  assert.deepEqual(o?.payload['receiver'], { ...RECEIVER_PROVENANCE });
  assert.equal(o?.provenance.origin, 'local');
});

test('half-written or wrong JSON is refused as MALFORMED, and the next good poll works', async () => {
  let body = '{"now": 1791, "aircraft": [';
  const { p, ctx } = setup(() => body);
  await p.initialize(ctx);
  await p.start();
  await assert.rejects(p.query({ signal: signal(), background: true }), (e: ProviderError) => e.code === 'MALFORMED');
  body = JSON.stringify({ aircraft: [] });
  await assert.rejects(
    p.query({ signal: signal(), background: true }),
    (e: ProviderError) => e.code === 'MALFORMED' && /"now"/.test(e.message),
  );
  body = JSON.stringify({ now: NOW_S, aircraft: [row('a1b2c3')] });
  assert.equal((await p.query({ signal: signal(), background: true })).length, 1);
});

test('corrupt rows are dropped and logged, good ones kept; rows heard without a position are not errors', async () => {
  const { p, ctx } = setup(() =>
    JSON.stringify({
      now: NOW_S,
      aircraft: [
        row('a1b2c3'),
        { hex: 'zzzzzz', lat: 21.3, lon: -157.9 },
        { hex: 'b2c3d4', lat: 95, lon: 0 },
        { hex: 'c3d4e5', flight: 'HAL12   ' },
        'not a row',
      ],
    }),
  );
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: signal(), background: true });
  assert.equal(obs.length, 1);
  const warn = ctx.logger.entries.find((e) => e.level === 'warn');
  assert.ok(warn, 'the corrupt rows are logged');
  assert.equal((await p.health()).status, 'LIVE');
});

test('a feed that is all corrupt is refused whole, never half-admitted', async () => {
  const { p, ctx } = setup(() => JSON.stringify({ now: NOW_S, aircraft: [{ hex: 'nope', lat: 1, lon: 1 }, 7] }));
  await p.initialize(ctx);
  await p.start();
  await assert.rejects(p.query({ signal: signal(), background: true }));
});

test('the same aircraft twice in one snapshot is one observation; an old position is flagged stale', async () => {
  const { p, ctx } = setup(() =>
    JSON.stringify({
      now: NOW_S,
      aircraft: [row('a1b2c3'), row('a1b2c3', { lat: 21.4 }), row('d4e5f6', { seen_pos: 75 })],
    }),
  );
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: signal(), background: true });
  assert.equal(obs.length, 2);
  const stale = obs.find((o) => o.externalId === 'd4e5f6');
  assert.ok(stale?.quality.flags?.includes('stale-position'));
  assert.equal(stale?.observedAt, new Date((NOW_S - 75) * 1000).toISOString(), 'timed by when the position was heard');
});

test('the decoder stops and comes back: OFFLINE in between, live again after, no request while it is gone', async () => {
  let down = false;
  const { p, ctx, reachable } = setup(() =>
    down ? { error: 'network' } : JSON.stringify({ now: NOW_S, aircraft: [row('a1b2c3')] }),
  );
  await p.initialize(ctx);
  await p.start();
  assert.equal((await p.query({ signal: signal(), background: true })).length, 1);
  down = true;
  delete reachable[DEFAULT_READSB_ENDPOINT];
  await assert.rejects(p.query({ signal: signal(), background: true }));
  await assert.rejects(p.query({ signal: signal(), background: true }), (e: ProviderError) => e.code === 'OFFLINE');
  assert.equal((await p.health()).status, 'OFFLINE');
  const requests = ctx.http.requests.length;
  await assert.rejects(p.query({ signal: signal(), background: true }), (e: ProviderError) => e.code === 'OFFLINE');
  assert.equal(ctx.http.requests.length, requests, 'not polled while not detected');
  // Back after the backoff.
  down = false;
  reachable[DEFAULT_READSB_ENDPOINT] = 200;
  ctx.clock.advance(30_000);
  assert.equal((await p.query({ signal: signal(), background: true })).length, 1);
  assert.equal((await p.health()).status, 'LIVE');
});
