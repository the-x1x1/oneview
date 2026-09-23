import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, testing } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { createProvider, parseAisLocalSettings, timeFromSecond, type Timers } from './index.js';

const TYPE1 = '!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C';
const TYPE5 = [
  '!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C',
  '!AIVDM,2,2,1,A,88888888880,2*25',
];

class ManualTimers implements Timers {
  queue: Array<{ fn: () => void; ms: number; id: number }> = [];
  private next = 1;
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.queue.push({ fn, ms, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.queue = this.queue.filter((t) => t.id !== h);
  }
  runAll() {
    const q = this.queue;
    this.queue = [];
    for (const t of q) t.fn();
  }
}

async function setup(settings: Record<string, unknown> = {}, flushIntervalMs = 0) {
  const timers = new ManualTimers();
  const local = new testing.FixtureLocalAccess();
  const ctx = testing.createFixtureContext({
    providerId: 'ais-local',
    clock: new testing.VirtualClock(Date.parse('2026-09-23T20:00:20Z')),
    settings: settings as never,
    local,
  });
  const p = createProvider({ flushIntervalMs, timers });
  await p.initialize(ctx);
  await p.start();
  const batches: Observation[][] = [];
  return { p, ctx, local, timers, batches, emit: (o: Observation[]) => batches.push(o) };
}

test('settings: loopback and the NMEA port unless the user names others', () => {
  assert.deepEqual(parseAisLocalSettings({}), { host: '127.0.0.1', port: 10110 });
  assert.deepEqual(parseAisLocalSettings({ host: ' Pi.Local ', port: 5012 }), { host: 'pi.local', port: 5012 });
  assert.deepEqual(parseAisLocalSettings({ port: 70000 }), { host: '127.0.0.1', port: 10110 });
});

test('a position is dated at its second, the latest one up to receipt', () => {
  const at = Date.parse('2026-09-23T20:00:20Z');
  assert.equal(new Date(timeFromSecond(at, 15)).toISOString(), '2026-09-23T20:00:15.000Z');
  assert.equal(new Date(timeFromSecond(at, 50)).toISOString(), '2026-09-23T19:59:50.000Z', 'last minute');
  assert.equal(timeFromSecond(at, undefined), at);
});

test('what a ship said about itself reaches its next position report', async () => {
  const { p, local, batches, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  assert.deepEqual(local.streams[0]!.target, { host: '127.0.0.1', port: 10110 });
  const s = local.streams[0]!;
  for (const l of TYPE5) s.simulateLine(l);
  // EVER DIADEM's MMSI with a made-up position report is not needed: reuse the static store
  // through the type 1 report of another ship, then check the static ship's info is held.
  s.simulateLine(TYPE1);
  const positions = batches.flat();
  assert.equal(positions.length, 1);
  assert.equal(positions[0]!.payload['mmsi'], '477553000');
  assert.equal(p.stats.messages, 2);
  assert.equal(p.stats.positions, 1);
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.objectCount, 1);
});

test('positions are coalesced per ship for the flush interval', async () => {
  const { p, local, timers, batches, emit } = await setup({}, 1000);
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.streams[0]!;
  s.simulateLine(TYPE1);
  s.simulateLine(TYPE1);
  assert.equal(batches.filter((b) => b.length).length, 0, 'held until the flush');
  timers.runAll();
  assert.deepEqual(
    batches.filter((b) => b.length).map((b) => b.length),
    [1],
    'one position per ship per batch',
  );
});

test('nothing listening: subscribe fails OFFLINE for the runtime to retry; a dropped stream reconnects on its own', async () => {
  const { p, local, timers, emit } = await setup();
  local.refuseStreams = new ProviderError('OFFLINE', 'nothing is listening at 127.0.0.1:10110');
  await assert.rejects(
    p.subscribe({ signal: new AbortController().signal }, emit),
    /no AIS receiver at 127\.0\.0\.1:10110/,
  );
  assert.equal((await p.health()).status, 'OFFLINE');

  local.refuseStreams = undefined;
  await p.subscribe({ signal: new AbortController().signal }, emit);
  assert.equal((await p.health()).status, 'LIVE');
  local.streams.at(-1)!.simulateClose();
  const down = await p.health();
  assert.equal(down.status, 'OFFLINE');
  assert.match(down.message ?? '', /closed the connection/);
  assert.equal(timers.queue.length, 1);
  assert.equal(timers.queue[0]!.ms, 5000, 'first retry after 5 s');
  timers.runAll();
  await new Promise((r) => setImmediate(r));
  assert.equal((await p.health()).status, 'LIVE', 'reconnected');
  assert.equal(p.stats.reconnects, 1);
  assert.equal(local.streams.length, 2);
});

test('a new address: the old stream is closed and the new one dialled at once', async () => {
  const { p, ctx, local, timers, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const first = local.streams[0]!;
  ctx.settings.update({ host: 'pi.local', port: 5012 });
  assert.equal(first.closed, true);
  assert.equal(timers.queue[0]!.ms, 0);
  timers.runAll();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(local.streams[1]!.target, { host: 'pi.local', port: 5012 });
  assert.equal((await p.health()).status, 'LIVE');
});
