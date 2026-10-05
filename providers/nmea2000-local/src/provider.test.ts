import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, testing } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { createProvider, OWN_VESSEL_ID, parseNmea2000LocalSettings, type Timers } from './index.js';

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'nmea2000-local',
  'stream.ydraw',
);
const LINES = readFileSync(fixture, 'utf8').trim().split('\n');

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

async function setup(settings: Record<string, unknown> = {}, flushIntervalMs = 1000) {
  const timers = new ManualTimers();
  const local = new testing.FixtureLocalAccess();
  const ctx = testing.createFixtureContext({
    providerId: 'nmea2000-local',
    clock: new testing.VirtualClock(Date.parse('2026-10-05T17:33:20Z')),
    settings: settings as never,
    local,
  });
  const p = createProvider({ flushIntervalMs, timers });
  await p.initialize(ctx);
  await p.start();
  const batches: Observation[][] = [];
  return { p, ctx, local, timers, batches, emit: (o: Observation[]) => batches.push(o) };
}

test('settings: loopback and port 1457 unless named; an MMSI of nine digits; a name', () => {
  assert.deepEqual(parseNmea2000LocalSettings({}), { host: '127.0.0.1', port: 1457, name: 'Own vessel' });
  assert.deepEqual(
    parseNmea2000LocalSettings({ host: ' YDWG.Local ', port: 2000, mmsi: '366123456', name: 'Kai Moana' }),
    { host: 'ydwg.local', port: 2000, mmsi: '366123456', name: 'Kai Moana' },
  );
  assert.equal(parseNmea2000LocalSettings({ mmsi: '12345' }).mmsi, undefined, 'not nine digits');
  assert.equal(parseNmea2000LocalSettings({ port: 70_000 }).port, 1457);
});

test('the fixture stream: the boat with every reading, and the two ships its AIS heard, named', async () => {
  const { p, local, timers, batches, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  assert.deepEqual(local.streams[0]!.target, { host: '127.0.0.1', port: 1457 });
  const s = local.streams[0]!;
  // The static reports first, as a ship sends them now and then; then the stream as recorded.
  for (const l of LINES.slice(26)) s.simulateLine(l);
  for (const l of LINES) s.simulateLine(l);
  timers.runAll();
  const seen = new Map(batches.flat().map((o) => [o.externalId, o]));
  assert.deepEqual([...seen.keys()].sort(), ['338234567', '366123456', OWN_VESSEL_ID]);
  const own = seen.get(OWN_VESSEL_ID)!;
  assert.equal(own.payload['name'], 'Own vessel');
  assert.equal(own.payload['ownVessel'], true);
  // The GNSS fix (129029) came after the rapid update and is the one used.
  assert.ok(Math.abs(own.position!.latitude - 21.30691234567) < 1e-9);
  assert.equal(own.payload['gnssSatellites'], 9);
  assert.equal(own.payload['headingDegrees'], 220.2);
  assert.equal(own.payload['depthM'], 12.34);
  assert.equal(own.payload['windSpeedMps'], 6.1);
  assert.equal(own.payload['windDirectionDegrees'], 275);
  assert.equal(own.payload['waterTemperatureC'], 17.25, 'the latest sea temperature (130312 after 130310)');
  assert.equal(own.provenance.origin, 'local');
  assert.equal(own.provenance.sourceRef, 'tcp://127.0.0.1:1457');
  const a = seen.get('366123456')!;
  assert.equal(a.payload['name'], 'PACIFIC TRADER');
  assert.equal(a.payload['destination'], 'HONOLULU');
  assert.equal(seen.get('338234567')!.payload['name'], 'SEA BREEZE');
  assert.equal(seen.get('338234567')!.payload['shipTypeText'], 'pleasure craft');
  assert.equal(p.stats.frames, LINES.length * 2 - 26);
  assert.equal(p.stats.invalid, 0);
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(h.message, "2 ships heard by the boat's AIS");
});

test("with the boat's MMSI set, it is that MMSI's object, and its own AIS reports are not a second ship", async () => {
  const { local, timers, batches, emit, p } = await setup({ mmsi: '366123456', name: 'Kai Moana' });
  await p.subscribe({ signal: new AbortController().signal }, emit);
  for (const l of LINES) local.streams[0]!.simulateLine(l);
  timers.runAll();
  const ids = new Set(batches.flat().map((o) => o.externalId));
  assert.deepEqual([...ids].sort(), ['338234567', '366123456']);
  const own = batches.flat().find((o) => o.externalId === '366123456')!;
  assert.equal(own.payload['ownVessel'], true, 'the boat, not the AIS report of it');
  assert.equal(own.payload['name'], 'Kai Moana');
  assert.equal(own.payload['flag'], 'United States');
});

test('what is not RAW, or not read, is counted and skipped; nothing can be written to the gateway', async () => {
  const { p, local, timers, batches, emit } = await setup({}, 0);
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.streams[0]!;
  s.simulateLine('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A');
  s.simulateLine('17:33:21.107 R 19F51323 01 2F 30 70 00 2F 30 70'); // 128275 distance log: not read
  timers.runAll();
  assert.equal(p.stats.invalid, 1);
  assert.equal(p.stats.ignored, 1);
  assert.equal(batches.flat().length, 0);
  // A line stream has no way to write: the provider cannot send anything onto the bus.
  assert.equal('write' in s, false);
});

test('no gateway: subscribe fails OFFLINE for the runtime to retry; a dropped stream reconnects on its own', async () => {
  const { p, local, timers, emit } = await setup();
  local.refuseStreams = new ProviderError('OFFLINE', 'nothing is listening at 127.0.0.1:1457');
  await assert.rejects(
    p.subscribe({ signal: new AbortController().signal }, emit),
    /no NMEA 2000 gateway at 127\.0\.0\.1:1457/,
  );
  assert.equal((await p.health()).status, 'OFFLINE');
  local.refuseStreams = undefined;
  await p.subscribe({ signal: new AbortController().signal }, emit);
  assert.equal((await p.health()).status, 'LIVE');
  local.streams.at(-1)!.simulateClose();
  const down = await p.health();
  assert.equal(down.status, 'OFFLINE');
  assert.match(down.message ?? '', /closed the connection/);
  assert.equal(timers.queue.find((t) => t.ms === 5000) !== undefined, true, 'first retry after 5 s');
  timers.runAll();
  await new Promise((r) => setImmediate(r));
  assert.equal((await p.health()).status, 'LIVE', 'reconnected');
  assert.equal(p.stats.reconnects, 1);
});

test('the boat is sent at most once a flush, dated by its newest reading, so each update has an id of its own', async () => {
  const { ctx, local, timers, batches, emit, p } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.streams[0]!;
  s.simulateLine(LINES[0]!); // position
  s.simulateLine(LINES[1]!); // course
  timers.runAll();
  ctx.clock.advance(1500);
  s.simulateLine(LINES[3]!); // depth only, no new position
  timers.runAll();
  const own = batches.flat().filter((o) => o.externalId === OWN_VESSEL_ID);
  assert.equal(own.length, 2);
  assert.notEqual(own[0]!.id, own[1]!.id);
  assert.equal(Date.parse(own[1]!.observedAt) - Date.parse(own[0]!.observedAt), 1500);
  assert.equal(own[1]!.payload['depthM'], 12.34);
});
