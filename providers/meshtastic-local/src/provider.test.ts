import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, testing } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { HEARTBEAT_MS } from './manifest.js';
import {
  createProvider,
  parseMeshtasticLocalSettings,
  PORT_POSITION,
  PORT_TEXT_MESSAGE,
  type Timers,
} from './index.js';
import { concat, deviceMetrics, fromRadio, nodeInfo, packet, position, user } from '../test/encode.js';

// Every node, name, place and message here is invented.
const START = Date.parse('2026-10-05T08:00:00Z');
const NOW_SEC = START / 1000;

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
  run(ms: number) {
    const due = this.queue.filter((t) => t.ms === ms);
    this.queue = this.queue.filter((t) => t.ms !== ms);
    for (const t of due) t.fn();
  }
}

async function setup(settings: Record<string, unknown> = {}, flushIntervalMs = 0) {
  const timers = new ManualTimers();
  const local = new testing.FixtureLocalAccess();
  const ctx = testing.createFixtureContext({
    providerId: 'meshtastic-local',
    clock: new testing.VirtualClock(START),
    settings: settings as never,
    local,
  });
  const p = createProvider({ flushIntervalMs, timers });
  await p.initialize(ctx);
  await p.start();
  const batches: Observation[][] = [];
  return { p, ctx, local, timers, batches, emit: (o: Observation[]) => batches.push(o) };
}

const ridge = nodeInfo({
  num: 0xa1b2c3d4,
  user: user({ longName: 'Ridge relay', shortName: 'RDG' }),
  position: position({ lat: 21.3069, lon: -157.8583, alt: 610, fixTime: NOW_SEC - 600 }),
  lastHeard: NOW_SEC - 60,
  device: deviceMetrics({ battery: 87, voltage: 4.05 }),
});
const base = nodeInfo({ num: 0x0a0b0c0d, user: user({ longName: 'Base station' }) });

test('settings: loopback and port 4403 unless the user names others', () => {
  assert.deepEqual(parseMeshtasticLocalSettings({}), { host: '127.0.0.1', port: 4403 });
  assert.deepEqual(parseMeshtasticLocalSettings({ host: ' Meshtastic.Local ', port: 4404 }), {
    host: 'meshtastic.local',
    port: 4404,
  });
  assert.deepEqual(parseMeshtasticLocalSettings({ port: 0 }), { host: '127.0.0.1', port: 4403 });
});

test('on connecting it asks for the node list; the list becomes sensors, then what the node hears', async () => {
  const { p, local, batches, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.byteStreams[0]!;
  assert.deepEqual(s.target, { host: '127.0.0.1', port: 4403 });
  assert.equal(s.written.length, 1);
  assert.deepEqual([...s.written[0]!.subarray(0, 5)], [0x94, 0xc3, 0x00, 0x06, 0x18], 'ToRadio want_config_id');
  assert.equal((await p.health()).message, 'waiting for the node list');

  s.simulateData(concat(fromRadio.myInfo(0x0a0b0c0d), fromRadio.nodeInfo(base), fromRadio.config()));
  // The node list arrives cut anywhere.
  const rest = concat(fromRadio.nodeInfo(ridge), fromRadio.configComplete(1));
  s.simulateData(rest.subarray(0, 7));
  s.simulateData(rest.subarray(7));
  const first = batches.flat();
  assert.equal(first.length, 1, 'the base station has no position: not drawn');
  const r = first[0]!;
  assert.equal(r.externalId, '!a1b2c3d4');
  assert.equal(r.objectType, 'sensor');
  assert.equal(r.payload['name'], 'Ridge relay');
  assert.equal(r.payload['batteryPct'], 87);
  assert.equal(r.provenance.origin, 'local');
  assert.equal(r.provenance.sourceRef, 'tcp://127.0.0.1:4403');
  assert.equal(r.observedAt, new Date((NOW_SEC - 600) * 1000).toISOString());
  const h = await p.health();
  assert.equal(h.status, 'LIVE');
  assert.equal(
    h.message,
    '2 nodes on the mesh, 1 with a position; this node: Base station, NO FIX (the node has not reported a position)',
  );
  assert.equal(h.objectCount, 1);

  // Then the mesh: a new position from the base station, and a text message that is never read.
  const before = batches.length;
  s.simulateData(
    concat(
      fromRadio.packet(
        packet({
          from: 0x0a0b0c0d,
          portnum: PORT_POSITION,
          payload: position({ lat: 21.29, lon: -157.84, source: 2, fixTime: NOW_SEC - 20, fixType: 3, sats: 9 }),
          rxTime: NOW_SEC,
        }),
      ),
      fromRadio.packet(
        packet({
          from: 0xa1b2c3d4,
          portnum: PORT_TEXT_MESSAGE,
          payload: [...new TextEncoder().encode('back at camp by six')],
        }),
      ),
    ),
  );
  const later = batches.slice(before).flat();
  assert.equal(later.length, 1);
  assert.equal(later[0]!.externalId, '!0a0b0c0d');
  assert.equal(later[0]!.payload['thisNode'], true);
  assert.deepEqual(later[0]!.payload['ownFix'], {
    kind: 'gps',
    source: 'own GPS',
    fixAt: new Date((NOW_SEC - 20) * 1000).toISOString(),
    satellites: 9,
    fixType: '3D',
  });
  assert.match((await p.health()).message!, /this node: Base station, GPS fix \(3D, 9 satellites\), 20 s old$/);
  assert.equal(p.stats.ignored, 1, 'the text message');
  assert.ok(!JSON.stringify(batches).includes('camp'), 'no word of it in any observation');
});

test('updates are coalesced per node for the flush interval', async () => {
  const { p, local, timers, batches, emit } = await setup({}, 1000);
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.byteStreams[0]!;
  for (const lat of [10, 10.1, 10.2])
    s.simulateData(fromRadio.packet(packet({ from: 5, portnum: PORT_POSITION, payload: position({ lat, lon: 20 }) })));
  assert.equal(batches.flat().length, 0);
  timers.run(1000);
  const out = batches.flat();
  assert.equal(out.length, 1);
  assert.equal(out[0]!.position?.latitude, 10.2);
});

test('a heartbeat every five minutes while connected; a reboot asks for the list again', async () => {
  const { p, local, timers, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.byteStreams[0]!;
  timers.run(HEARTBEAT_MS);
  assert.deepEqual([...s.written[1]!], [0x94, 0xc3, 0x00, 0x02, 0x3a, 0x00]);
  timers.run(HEARTBEAT_MS);
  assert.equal(s.written.length, 3, 'and again');
  s.simulateData(fromRadio.rebooted());
  assert.equal(s.written[3]![4], 0x18, 'want_config_id after the reboot');
});

test('the node goes away: OFFLINE, said at once, and reconnected on its own', async () => {
  const { p, local, timers, batches, emit } = await setup({ host: 'meshtastic.local' });
  await p.subscribe({ signal: new AbortController().signal }, emit);
  assert.deepEqual(local.byteStreams[0]!.target, { host: 'meshtastic.local', port: 4403 });
  local.byteStreams[0]!.simulateClose();
  const h = await p.health();
  assert.equal(h.status, 'OFFLINE');
  assert.match(h.message ?? '', /meshtastic\.local:4403 closed the connection/);
  assert.deepEqual(batches.at(-1), [], 'the health is published with an empty batch');
  assert.equal(
    timers.queue.some((t) => t.ms === HEARTBEAT_MS),
    false,
    'no heartbeat to a closed connection',
  );
  timers.run(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(local.byteStreams.length, 2);
  assert.equal(local.byteStreams[1]!.written.length, 1, 'the new connection asks for the list again');
  assert.equal((await p.health()).status, 'LIVE');
  assert.equal(p.stats.reconnects, 1);
});

test('nothing listening is OFFLINE with the address; a host without byte streams is UNSUPPORTED', async () => {
  const { p, local, emit } = await setup();
  local.refuseStreams = new ProviderError('OFFLINE', 'nothing is listening at 127.0.0.1:4403');
  await assert.rejects(
    p.subscribe({ signal: new AbortController().signal }, emit),
    (e: unknown) =>
      e instanceof ProviderError && e.code === 'OFFLINE' && /no Meshtastic node at 127\.0\.0\.1:4403/.test(e.message),
  );
  assert.equal((await p.health()).status, 'OFFLINE');

  const bare = testing.createFixtureContext({ providerId: 'meshtastic-local', clock: new testing.VirtualClock(START) });
  const q = createProvider();
  await q.initialize({ ...bare, local: { ...bare.local, openByteStream: undefined } as never });
  await q.start();
  await assert.rejects(
    q.subscribe({ signal: new AbortController().signal }, () => undefined),
    /UNSUPPORTED|byte streams/,
  );
});

test('a new address drops the connection and dials the new one', async () => {
  const { p, ctx, local, timers, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  ctx.settings.update({ host: 'pi.lan', port: 4403 });
  assert.equal(local.byteStreams[0]!.closed, true);
  timers.run(0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(local.byteStreams[1]!.target, { host: 'pi.lan', port: 4403 });
});

test('garbage on the stream is skipped and counted, never fatal', async () => {
  const { p, local, batches, emit } = await setup();
  await p.subscribe({ signal: new AbortController().signal }, emit);
  const s = local.byteStreams[0]!;
  s.simulateData(Uint8Array.from([0x94, 0xc3, 0x00, 0x03, 0x12, 0x09, 0x01])); // a length past the end
  s.simulateData(fromRadio.nodeInfo(ridge));
  assert.equal(p.stats.invalid, 1);
  assert.equal(batches.flat().length, 1);
});

const fixAt = (num: number, lat: number) =>
  nodeInfo({ num, position: position({ lat, lon: -157.8, source: 2, fixTime: NOW_SEC - 5, fixType: 3 }) });
const noFix = (num: number) =>
  fromRadio.packet(packet({ from: num, portnum: PORT_POSITION, payload: position({ lat: 0, lon: 0, source: 2 }) }));

test('another node plugged in: the old one is redrawn as a neighbour, no longer "this node"', async () => {
  const { p, local, emit } = await setup();
  const metas: boolean[] = [];
  const all: Observation[][] = [];
  await p.subscribe({ signal: new AbortController().signal }, (o, meta) => {
    emit(o);
    all.push(o);
    metas.push(meta?.snapshot ?? false);
  });
  const s = local.byteStreams[0]!;
  s.simulateData(concat(fromRadio.myInfo(1), fromRadio.nodeInfo(fixAt(1, 21.3)), fromRadio.nodeInfo(fixAt(2, 21.4))));
  const own1 = all.flat().find((o) => o.externalId === '!00000001')!;
  assert.equal(own1.payload['thisNode'], true);
  s.simulateData(fromRadio.myInfo(2));
  assert.equal(metas[metas.length - 1], true, 'a full set');
  const last = all[all.length - 1]!;
  const n1 = last.find((o) => o.externalId === '!00000001')!;
  const n2 = last.find((o) => o.externalId === '!00000002')!;
  assert.equal(n1.payload['thisNode'], false);
  assert.equal(n1.payload['ownFix'], null);
  assert.equal(n2.payload['thisNode'], true);
});

test('subscribed again, then NO FIX: this node still comes off the map', async () => {
  const { p, local } = await setup();
  const first = new AbortController();
  await p.subscribe({ signal: first.signal }, () => undefined);
  local.byteStreams[0]!.simulateData(
    concat(fromRadio.myInfo(1), fromRadio.nodeInfo(fixAt(1, 21.3)), fromRadio.nodeInfo(fixAt(2, 21.4))),
  );
  first.abort();
  const out: Array<{ o: Observation[]; snapshot: boolean }> = [];
  await p.subscribe({ signal: new AbortController().signal }, (o, meta) =>
    out.push({ o, snapshot: meta?.snapshot ?? false }),
  );
  const s = local.byteStreams[1]!;
  s.simulateData(concat(fromRadio.myInfo(1), noFix(1), fromRadio.configComplete(2)));
  const snaps = out.filter((b) => b.snapshot);
  assert.ok(snaps.length > 0);
  assert.deepEqual(
    snaps[snaps.length - 1]!.o.map((o) => o.externalId),
    ['!00000002'],
    'only the neighbour; this node, with NO FIX, is not drawn',
  );
  assert.match((await p.health()).message!, /NO FIX$/);
  assert.equal((await p.health()).objectCount, 1, 'the count matches the map');
});
