import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Observation } from '@worldview/world-model';
import { testing } from '@worldview/provider-sdk';
import { HistoryStore, NdjsonBackend, hash53, observationFingerprint, partitionFilePath } from './index.js';
import {
  AIRCRAFT_PROVIDER,
  OPEN_POLICY,
  QUAKE_PROVIDER,
  aircraftObs,
  batch,
  makeLogger,
  policies,
  quakeObs,
  rowsFor,
  tempDir,
  wrapBackend,
} from '../test/helpers/fixtures.js';

const { VirtualClock } = testing;
const SAT = 'celestrak';
const T0 = '2026-09-22T12:00:00.000Z';

/** A satellite as CelesTrak reports it: observedAt is the element set's epoch; the position is propagated. */
function satObs(
  norad: number,
  epoch: string,
  lat: number,
  lon: number,
  elementsHash = `elements-${norad}`,
): Observation {
  return {
    id: `${SAT}:${norad}:${epoch}`,
    providerId: SAT,
    externalId: String(norad),
    objectType: 'satellite',
    observedAt: epoch,
    receivedAt: T0,
    position: { latitude: lat, longitude: lon, altitudeM: 550_000 },
    payload: { name: `SAT ${norad}`, noradId: norad, propagatedAt: `${lat},${lon}` },
    quality: { complete: true, sourceQuality: 'authoritative' },
    rawPayloadHash: elementsHash,
    provenance: { providerId: SAT, sourceName: 'CelesTrak', origin: 'live', receivedAt: T0 },
  };
}

async function makeStore() {
  const dataDir = await tempDir();
  const clock = new VirtualClock(Date.parse(T0));
  const { hub, sink } = makeLogger();
  const backend = new NdjsonBackend({ dataDir, logger: hub.logger('history'), clock });
  const store = new HistoryStore({
    dataDir,
    backend,
    clock,
    logger: hub.logger('history'),
    policies: policies({ [SAT]: OPEN_POLICY, [AIRCRAFT_PROVIDER]: OPEN_POLICY, [QUAKE_PROVIDER]: OPEN_POLICY }),
  });
  await store.open();
  return { store, backend, clock, sink, dataDir };
}

test('fingerprint: same observation id and source hash match whatever the position; content decides without a hash', () => {
  const a = { observationId: 'x', payloadJson: '{}', lat: 1, lon: 2 };
  assert.equal(observationFingerprint(a, 'h'), observationFingerprint({ ...a, lat: 50 }, 'h'));
  assert.notEqual(observationFingerprint(a, 'h'), observationFingerprint(a, 'h2'));
  assert.notEqual(observationFingerprint(a, undefined), observationFingerprint({ ...a, lat: 50 }, undefined));
  assert.notEqual(observationFingerprint(a, 'h'), observationFingerprint({ ...a, observationId: 'y' }, 'h'));
  assert.ok(Number.isSafeInteger(hash53('anything')));
  assert.notEqual(hash53('ab'), hash53('ba'));
});

test('write path: a satellite re-propagated from one element set is written once; a new element set is written', async () => {
  const { store } = await makeStore();
  const epoch = '2026-09-22T06:00:00.000Z';
  // Four polls, fifteen seconds apart, one element set: four positions, one observation.
  for (let i = 0; i < 4; i++) {
    const r = store.writeBatch(batch(SAT, [satObs(25544, epoch, i, i * 2), satObs(48274, epoch, -i, i)]));
    assert.equal(r.skippedUnchanged, i === 0 ? 0 : 2, `poll ${i}`);
  }
  // CelesTrak publishes a new element set for one of them.
  const next = store.writeBatch(batch(SAT, [satObs(25544, '2026-09-22T11:00:00.000Z', 9, 9, 'elements-25544-v2')]));
  assert.equal(next.queued, 1);
  await store.flush();
  const usage = await store.usage();
  const sat = usage.byType.find((t) => t.objectType === 'satellite');
  assert.equal(sat?.rows, 3, 'two element sets for one satellite, one for the other');
  assert.equal(usage.skippedUnchanged, 6);
  assert.equal(store.getStats().skippedUnchanged, 6);
});

test('write path: an aircraft moving and an earthquake revised are both still written every time', async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 3; i++) {
    const r = store.writeBatch(
      batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', new Date(Date.parse(T0) + i * 10_000).toISOString(), i, i)]),
    );
    assert.equal(r.queued, 1);
  }
  // A revision keeps the event's time and id, and changes what the source said.
  const quake = quakeObs('us1', T0, 19, -155, 4.1);
  assert.equal(store.writeBatch(batch(QUAKE_PROVIDER, [quake])).queued, 1);
  assert.equal(store.writeBatch(batch(QUAKE_PROVIDER, [quake])).skippedUnchanged, 1, 'the same report again');
  const revised = { ...quakeObs('us1', T0, 19, -155, 4.4), rawPayloadHash: 'hash-us1-rev2' };
  assert.equal(store.writeBatch(batch(QUAKE_PROVIDER, [revised])).queued, 1, 'the revision');
});

test('sweep: history written before dedupe is rewritten once without its repeats, streaming; movement types are left to their tiers', async () => {
  const { store, backend, clock, dataDir } = await makeStore();
  const epoch = '2026-09-22T06:00:00.000Z';
  // What an rc.3 install wrote: the same two element sets, forty times, straight to the backend.
  const repeated: Observation[] = [];
  for (let i = 0; i < 40; i++) repeated.push(satObs(1, epoch, i, i), satObs(2, epoch, -i, i));
  const satRows = rowsFor(repeated);
  await backend.append(
    satRows[0]!.key,
    satRows.map((r) => r.row),
  );
  const planes = rowsFor([aircraftObs('p1', T0, 1, 1), aircraftObs('p1', T0, 1, 1)]);
  await backend.append(
    planes[0]!.key,
    planes.map((r) => r.row),
  );

  // Written a moment ago: deduped anyway — no append can land mid-rewrite, and the size
  // cap, later in the same sweep, must not delete what the dedupe would have compacted.
  const report = await store.sweepRetention();
  assert.equal(report.deduped.length, 1, 'the satellite partition only');
  const d = report.deduped[0]!;
  assert.equal(d.rowsBefore, 80);
  assert.equal(d.rowsAfter, 2);
  assert.ok(d.bytesAfter < d.bytesBefore / 20, `${d.bytesAfter} of ${d.bytesBefore}`);
  const [meta] = await backend.listPartitions({ objectTypes: ['satellite'] });
  assert.equal(meta?.rows, 2);
  assert.equal(meta?.originalRows, 80, 'the index keeps what was ever written');
  assert.ok(meta?.dedupedAt);
  const file = partitionFilePath(path.join(dataDir, 'history'), meta!, 'ndjson');
  assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 2, 'the file itself');
  const back = await store.objectsAt(new Date(clock.now()).toISOString(), {
    lookbackSeconds: 86_400,
    objectTypes: ['satellite'],
  });
  assert.deepEqual(back.map((r) => r.externalId).sort(), ['1', '2'], 'both satellites still in history');

  const again = await store.sweepRetention();
  assert.deepEqual(again.deduped, [], 'once only');
  const aircraft = await backend.listPartitions({ objectTypes: ['aircraft'] });
  assert.equal(aircraft[0]?.rows, 2, 'aircraft untouched by dedupe');
});

test('size cap: over it, the oldest partitions go first until history is at 90 %; kept-forever types are never touched', async () => {
  const { store, backend, clock, sink } = await makeStore();
  // Six hours of aircraft, one partition an hour, and an earthquake from the first hour.
  for (let h = 0; h < 6; h++) {
    const at = new Date(Date.parse(T0) - (6 - h) * 3_600_000).toISOString();
    const rows = rowsFor(Array.from({ length: 50 }, (_, i) => aircraftObs(`a${i}`, at, h, i)));
    await backend.append(
      rows[0]!.key,
      rows.map((r) => r.row),
    );
  }
  const q = rowsFor([quakeObs('us9', new Date(Date.parse(T0) - 7 * 3_600_000).toISOString(), 1, 1, 5)]);
  await backend.append(q[0]!.key, [q[0]!.row]);
  const before = await store.usage();
  const aircraftBytes = before.byType.find((t) => t.objectType === 'aircraft')!.bytes;

  assert.deepEqual(await store.enforceSizeCap(), [], 'no cap, nothing deleted');
  store.setMaxBytes(aircraftBytes / 2);
  const deleted = await store.enforceSizeCap(clock.now());
  assert.ok(deleted.length >= 3, `${deleted.length}`);
  assert.ok(deleted.every((m) => m.objectType === 'aircraft'));
  const order = deleted.map((m) => m.maxObservedAt);
  assert.deepEqual(order, [...order].sort(), 'oldest first');
  const after = await store.usage();
  assert.ok(after.bytes <= (aircraftBytes / 2) * 0.9 + 1, `${after.bytes}`);
  assert.equal(after.byType.find((t) => t.objectType === 'earthquake')?.rows, 1, 'earthquakes are kept indefinitely');
  assert.equal(after.maxBytes, aircraftBytes / 2);
  assert.ok(sink.records.some((r) => r.message.includes('size cap reached')));
});

test('a rewrite and an append to the same partition never interleave: the appended rows survive', async () => {
  const dataDir = await tempDir();
  const clock = new VirtualClock(Date.parse(T0));
  const inner = new NdjsonBackend({ dataDir, clock });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((r) => (releaseRead = r));
  let reading = false;
  const wrapped = wrapBackend(inner, {
    readPartition: async (k) => {
      reading = true;
      await readGate;
      return inner.readPartition(k);
    },
  });
  // Without the streaming rewrite, so the store takes the read-then-rewrite path.
  const { dedupePartition: _streaming, ...backend } = wrapped;
  const store = new HistoryStore({ dataDir, backend, clock, policies: policies({ [SAT]: OPEN_POLICY }) });
  await store.open();
  const epoch = '2026-09-22T06:00:00.000Z';
  const old = rowsFor([satObs(1, epoch, 0, 0), satObs(1, epoch, 1, 1)]);
  await inner.append(
    old[0]!.key,
    old.map((r) => r.row),
  );
  const sweeping = store.sweepRetention();
  while (!reading) await new Promise((r) => setTimeout(r, 1));
  // A new element set lands in the same hour's partition while the sweep holds it.
  store.writeBatch(batch(SAT, [satObs(2, '2026-09-22T06:30:00.000Z', 5, 5)]));
  await new Promise((r) => setTimeout(r, 5));
  releaseRead();
  await sweeping;
  await store.flush();
  const [meta] = await inner.listPartitions({ objectTypes: ['satellite'] });
  assert.equal(meta?.rows, 2, 'one deduped satellite and the one appended during the sweep');
  const { rows } = await inner.readPartition(meta!);
  assert.deepEqual(rows.map((r) => r.externalId).sort(), ['1', '2']);
});

test('streaming thinning equals the in-memory one, and stripping alone numbers nothing', async () => {
  const { backend } = await makeStore();
  const obs: Observation[] = [];
  // Two aircraft, interleaved as polls append them, 90 positions each.
  for (let i = 0; i < 90; i++)
    for (const id of ['aa1', 'bb2'])
      obs.push(aircraftObs(id, new Date(Date.parse(T0) + i * 10_000).toISOString(), i / 10, i / 10));
  const rows = rowsFor(obs);
  const key = rows[0]!.key;
  await backend.append(
    key,
    rows.map((r) => r.row),
  );
  const { downsampleRows, planThinning, TRACK_DOWNSAMPLE_TIERS } = await import('./index.js');
  const expected = downsampleRows(
    rows.map((r) => ({ ...r.row })),
    TRACK_DOWNSAMPLE_TIERS,
    2,
  ).rows.map((r) => `${r.objectId}#${r.seq}`);

  // Strip first (tier 0), then thin to tier 2: the same rows as thinning the original directly.
  const meta = (await backend.listPartitions())[0]!;
  const strip = await backend.thinPartition(meta, {
    plan: (cols) => planThinning(cols, TRACK_DOWNSAMPLE_TIERS, 0),
    stripRaw: true,
    meta: { originalRows: meta.originalRows, rawStripped: true },
  });
  assert.equal(strip?.rowsAfter, 180);
  assert.equal(strip?.stripped, 180);
  const afterStrip = await backend.readPartition(meta);
  assert.ok(afterStrip.rows.every((r) => r.seq === undefined && r.rawPayloadHash === undefined));

  const thin = await backend.thinPartition(meta, {
    plan: (cols) => planThinning(cols, TRACK_DOWNSAMPLE_TIERS, 2),
    stripRaw: false,
    meta: { originalRows: meta.originalRows, downsampleTier: 2, rawStripped: true },
  });
  const got = (await backend.readPartition(meta)).rows.map((r) => `${r.objectId}#${r.seq}`);
  assert.deepEqual(got.sort(), expected.sort());
  assert.equal(thin?.partition.downsampleTier, 2);
  assert.equal(thin?.partition.originalRows, 180);
});

test('one sweep dedupes before it caps: history over the cap only because of repeats loses nothing', async () => {
  const { store, backend } = await makeStore();
  const epoch = '2026-09-22T06:00:00.000Z';
  const repeated: Observation[] = [];
  for (let i = 0; i < 200; i++) repeated.push(satObs(7, epoch, i, i));
  const rows = rowsFor(repeated);
  await backend.append(
    rows[0]!.key,
    rows.map((r) => r.row),
  );
  const before = (await store.usage()).bytes;
  // A cap the repeats exceed and the one real observation does not.
  store.setMaxBytes(before / 10);
  const report = await store.sweepRetention();
  assert.equal(report.deduped.length, 1);
  assert.deepEqual(report.capped, [], 'nothing deleted');
  const after = await store.usage();
  assert.equal(after.byType.find((t) => t.objectType === 'satellite')?.rows, 1);
});
