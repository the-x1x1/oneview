import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, type ProviderError } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { AisStreamProvider, type Timers } from '../../src/index.js';

const T0 = Date.parse('2026-09-21T08:00:10.000Z');
const HONOLULU = { west: -158.3, south: 21.1, east: -157.6, north: 21.5 };
const framesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'aisstream', 'frames');
const frame = (name: string) => readFileSync(path.join(framesDir, name), 'utf8');
const settle = () => new Promise<void>((r) => setImmediate(r));

/** Deterministic timers bound to the virtual clock. */
class ManualTimers implements Timers {
  private seq = 0;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();
  constructor(private readonly clock: testing.VirtualClock) {}
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.seq; this.queue.set(id, { at: this.clock.now() + ms, fn }); return id; }
  clearTimeout(handle: unknown): void { this.queue.delete(handle as number); }
  get pending(): number { return this.queue.size; }
  nextDueIn(): number | undefined { const at = Math.min(...[...this.queue.values()].map((t) => t.at)); return Number.isFinite(at) ? at - this.clock.now() : undefined; }
  /** Advance the clock, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const target = this.clock.now() + ms;
    for (;;) {
      const due = [...this.queue.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.queue.delete(due[0]);
      this.clock.set(due[1].at);
      due[1].fn();
      await settle();
    }
    this.clock.set(target);
  }
}

async function setup(opts: { credential?: boolean; resolver?: boolean; flushIntervalMs?: number; online?: boolean } = {}) {
  const clock = new testing.VirtualClock(T0);
  const timers = new ManualTimers(clock);
  const ctx = testing.createFixtureContext({ providerId: 'aisstream-io', clock, ...(opts.credential === false ? {} : { credentials: ['aisstream.apiKey'] }), ...(opts.online === false ? { online: false } : {}) });
  const p = new AisStreamProvider({ ...(opts.resolver === false ? {} : { secretResolver: async (k) => (k === 'aisstream.apiKey' ? 'secret-key' : undefined) }), flushIntervalMs: opts.flushIntervalMs ?? 0, timers });
  await p.initialize(ctx);
  await p.start();
  const batches: Array<{ obs: Observation[]; snapshot: boolean | undefined }> = [];
  const emit = (obs: Observation[], meta?: { snapshot: boolean }) => { batches.push({ obs, snapshot: meta?.snapshot }); };
  return { p, ctx, timers, clock, batches, emit, socket: (i = 0) => ctx.sockets.opened[i]!.handle };
}

test('subscribe: missing credential → AUTH and AUTH_REQUIRED health with a plain message', async () => {
  const { p, emit } = await setup({ credential: false });
  await assert.rejects(p.subscribe({ signal: new AbortController().signal }, emit), (e: ProviderError) => e.code === 'AUTH' && /aisstream\.apiKey/.test(e.message));
  const h = await p.health();
  assert.equal(h.status, 'AUTH_REQUIRED');
  assert.equal(h.credentialState, 'missing');
});

test('subscribe: without a resolver the key arrives through the socket handshake (ADR-003 onOpen ctx.secret)', async () => {
  const { p, ctx, emit, socket } = await setup({ resolver: false });
  ctx.sockets.secrets['aisstream.apiKey'] = 'runtime-supplied-key';
  const unsub = await p.subscribe({ signal: new AbortController().signal }, emit);
  assert.deepEqual(ctx.sockets.opened[0]?.credential, { key: 'aisstream.apiKey' }, 'the provider asks the runtime to resolve the credential');
  const s = socket();
  assert.equal(s.sent.length, 0, 'nothing sent before the handshake');
  s.simulateOpen();
  const sub = JSON.parse(String(s.sent[0])) as { APIKey: string };
  assert.equal(sub.APIKey, 'runtime-supplied-key');
  assert.ok(!ctx.logger.entries.some((e) => JSON.stringify(e).includes('runtime-supplied-key')), 'the key never reaches the log');
  unsub();
});

test('subscribe: no resolver and no handshake secret → AUTH, socket closed, nothing sent', async () => {
  const { p, ctx, emit, socket } = await setup({ resolver: false });
  const unsub = await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = socket();
  s.simulateOpen();
  assert.equal(s.sent.length, 0, 'no subscription frame without a key');
  assert.equal(s.closed, true);
  const h = await p.health();
  assert.equal(h.lastError?.code, 'AUTH');
  assert.equal(ctx.sockets.opened.length, 1);
  unsub();
});

test('subscribe: an initial open failure (offline) rejects so the runtime backs off', async () => {
  const clock = new testing.VirtualClock(T0);
  const ctx = testing.createFixtureContext({ providerId: 'aisstream-io', clock, credentials: ['aisstream.apiKey'], sockets: { open: async () => { throw new (await import('@worldview/provider-sdk')).ProviderError('OFFLINE', 'application offline'); } } as unknown as testing.FixtureSockets });
  const p = new AisStreamProvider({ secretResolver: async () => 'k', flushIntervalMs: 0, timers: new ManualTimers(clock) });
  await p.initialize(ctx);
  await p.start();
  await assert.rejects(p.subscribe({ signal: new AbortController().signal }, () => {}), (e: ProviderError) => e.code === 'OFFLINE');
  assert.equal((await p.health()).status, 'OFFLINE');
});

test('frames: subscription frame carries the key and viewport boxes; observations emitted per frame with snapshot:false; out-of-bounds and malformed frames dropped', async () => {
  const { p, ctx, batches, emit, socket } = await setup();
  const unsub = await p.subscribe({ signal: new AbortController().signal, bounds: HONOLULU }, emit);
  const s = socket();
  assert.equal(ctx.sockets.opened[0]?.url, 'wss://stream.aisstream.io/v0/stream');
  assert.equal(s.sent.length, 0, 'nothing sent before the handshake');
  s.simulateOpen();
  assert.equal(s.sent.length, 1);
  const sub = JSON.parse(String(s.sent[0])) as { APIKey: string; BoundingBoxes: number[][][]; FilterMessageTypes: string[] };
  assert.equal(sub.APIKey, 'secret-key');
  assert.deepEqual(sub.BoundingBoxes, [[[21.1, -158.3], [21.5, -157.6]]]);
  assert.equal((await p.health()).status, 'STARTING', 'handshake alone is not liveness');
  assert.ok(!ctx.logger.entries.some((e) => JSON.stringify(e).includes('secret-key')), 'the key never reaches the log');

  for (const f of ['01-position-report.json', '02-position-heading-511.json', '03-position-anchored.json', '04-ship-static-data.json', '05-malformed.json', '06-out-of-bounds.json']) s.simulateMessage(frame(f));
  s.simulateMessage(frame('08-not-json.txt'));
  s.simulateMessage(new TextEncoder().encode(frame('01-position-report.json')));
  assert.equal(batches.length, 5, 'one batch per admitted frame (flushIntervalMs 0)');
  assert.ok(batches.every((b) => b.snapshot === false));
  const ids = batches.flatMap((b) => b.obs.map((o) => o.externalId));
  assert.deepEqual(ids, ['366123456', '338987654', '002320001', '366123456', '366123456']);
  assert.equal(p.stats.outOfBounds, 1);
  assert.equal(p.stats.malformed, 2);
  assert.equal(p.stats.frames, 8);
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.objectCount, 3);
  assert.equal(h.errorRate, 0);
  assert.equal(h.lastObservation, '2026-09-21T08:00:06.250Z');
  unsub();
  assert.equal(s.closed, true);
  s.simulateMessage(frame('01-position-report.json'));
  assert.equal(batches.length, 5, 'frames after unsubscribe are ignored');
  assert.equal((await p.health()).status, 'LIVE', 'recent data keeps the health LIVE after unsubscribe');
});

test('frames: batches are coalesced for flushIntervalMs, deduplicated by observation id', async () => {
  const { p, timers, batches, emit, socket } = await setup({ flushIntervalMs: 500 });
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = socket();
  s.simulateOpen();
  s.simulateMessage(frame('01-position-report.json'));
  s.simulateMessage(frame('01-position-report.json'));
  s.simulateMessage(frame('02-position-heading-511.json'));
  assert.equal(batches.length, 0);
  await timers.advance(499);
  assert.equal(batches.length, 0);
  await timers.advance(1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.obs.map((o) => o.externalId), ['366123456', '338987654']);
});

test('reconnect: an abnormal close reconnects after the backoff; late frames on the old socket are ignored', async () => {
  const { p, ctx, timers, batches, emit, socket } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const first = socket(0);
  first.simulateOpen();
  first.simulateMessage(frame('01-position-report.json'));
  assert.equal((await p.health()).status, 'LIVE');
  first.simulateClose(1006, 'abnormal');
  let h = await p.health();
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.message ?? '', /socket closed/);
  assert.equal(ctx.sockets.opened.length, 1);
  assert.equal(timers.nextDueIn(), 5000, 'first rung of the ladder');
  await timers.advance(5000);
  assert.equal(ctx.sockets.opened.length, 2, 'a new socket generation was opened');
  assert.equal(p.stats.reconnects, 1);
  first.simulateMessage(frame('02-position-heading-511.json'));
  assert.equal(batches.length, 1, 'orphan socket frames are dropped');
  const second = socket(1);
  second.simulateOpen();
  assert.equal(second.sent.length, 1, 'new socket re-subscribes');
  second.simulateMessage(frame('02-position-heading-511.json'));
  assert.equal(batches.length, 2);
  h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.errorRate, 0, 'the first socket delivered data before it died');
});

test('reconnect: repeated failures walk the ladder 5 s → 15 s → 60 s → 300 s, then down (15 min)', async () => {
  const { p, ctx, timers, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const expected = [5000, 15_000, 60_000, 300_000, 900_000];
  for (const [i, delay] of expected.entries()) {
    ctx.sockets.opened[i]!.handle.simulateClose(1006, 'abnormal');
    assert.equal(timers.nextDueIn(), delay, `attempt ${i + 1}`);
    await timers.advance(delay);
    assert.equal(ctx.sockets.opened.length, i + 2);
  }
  const h = await p.health();
  assert.equal(h.status, 'OFFLINE', 'never had data and the failures were transport-level');
  assert.equal(h.errorRate, 1);
});

test('watchdog: 90 s without frames recycles the socket and reconnects', async () => {
  const { p, ctx, timers, emit, socket } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = socket();
  s.simulateOpen();
  s.simulateMessage(frame('01-position-report.json'));
  await timers.advance(89_000);
  assert.equal(s.closed, false);
  assert.equal((await p.health()).status, 'LIVE');
  await timers.advance(2000);
  assert.equal(s.closed, true, 'silent socket recycled');
  assert.equal(p.watchdogStatus, 'reconnecting');
  let h = await p.health();
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.message ?? '', /no AIS data for 9\d s/);
  await timers.advance(5000);
  assert.equal(ctx.sockets.opened.length, 2);
  const s2 = socket(1);
  s2.simulateOpen();
  s2.simulateMessage(frame('03-position-anchored.json'));
  h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.message, undefined);
});

test('auth: an error envelope rejecting the key closes the socket, reports AUTH_REQUIRED/invalid and waits for a credential change', async () => {
  const { p, ctx, timers, emit, socket } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = socket();
  s.simulateOpen();
  s.simulateMessage(frame('07-auth-error.json'));
  assert.equal(s.closed, true);
  const h = await p.health();
  assert.equal(h.status, 'AUTH_REQUIRED');
  assert.equal(h.credentialState, 'invalid');
  assert.match(h.message ?? '', /Api Key Is Not Valid/);
  assert.equal(timers.nextDueIn(), 3_600_000, 'only the slow auth probe is scheduled');
  await timers.advance(600_000);
  assert.equal(ctx.sockets.opened.length, 1, 'no fast retry on a refused key');
  p.notifyCredentialChange();
  await settle();
  assert.equal(ctx.sockets.opened.length, 2, 'credential change reconnects immediately');
  socket(1).simulateOpen();
  socket(1).simulateMessage(frame('01-position-report.json'));
  assert.equal((await p.health()).status, 'LIVE');
});

test('lifecycle: stop() tears the session down and clears every timer', async () => {
  const { p, timers, emit, socket } = await setup({ flushIntervalMs: 500 });
  await p.subscribe({ signal: new AbortController().signal }, emit);
  socket().simulateOpen();
  socket().simulateMessage(frame('01-position-report.json'));
  assert.ok(timers.pending >= 2);
  await p.stop();
  assert.equal(timers.pending, 0);
  assert.equal(socket().closed, true);
  assert.equal((await p.health()).status, 'DISABLED');
});
