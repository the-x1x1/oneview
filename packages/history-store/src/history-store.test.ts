import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@worldview/provider-sdk';
import { defaultIdentityResolver } from '@worldview/identity';
import {
  HistoryStore, NdjsonBackend, TimelineController, createHistoryBackend, downsampleRows, effectiveRetentionSeconds, lineToRow, partitionId, partitionKeyFor,
  partitionRelativePath, parsePartitionRelativePath, retentionPolicyFor, rowToObservation, tierForAge, TRACK_DOWNSAMPLE_TIERS,
  type HistoryBackend, type HistoryRow, type PartitionKey,
} from './index.js';
import { runBackendConformance } from '../test/helpers/backend-conformance.js';
import {
  AIRCRAFT_PROVIDER, CAPPED_POLICY, NO_RAW_POLICY, NO_RETAIN_POLICY, OPEN_POLICY, QUAKE_PROVIDER,
  aircraftObs, batch, iso, makeLogger, policies, quakeObs, rowsFor, tempDir, wrapBackend,
} from '../test/helpers/fixtures.js';

const { VirtualClock } = testing;
const D1 = '2026-09-19T08:00:00.000Z', D2 = '2026-09-20T08:00:00.000Z', D3 = '2026-09-21T08:00:00.000Z';

async function makeStore(overrides: Partial<ConstructorParameters<typeof HistoryStore>[0]> = {}) {
  const dataDir = await tempDir();
  const clock = new VirtualClock(Date.parse(iso(D3, 3600)));
  const { hub, sink } = makeLogger();
  const backend = new NdjsonBackend({ dataDir, logger: hub.logger('history'), clock });
  const store = new HistoryStore({
    dataDir, backend, clock, logger: hub.logger('history'),
    policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY, [QUAKE_PROVIDER]: OPEN_POLICY, 'no-raw': NO_RAW_POLICY, 'no-retain': NO_RETAIN_POLICY, capped: CAPPED_POLICY }),
    ...overrides,
  });
  await store.open();
  return { store, backend, clock, sink, dataDir };
}

function threeDays(): Array<ReturnType<typeof batch>> {
  const out: Array<ReturnType<typeof batch>> = [];
  for (const day of [D1, D2, D3]) {
    out.push(batch(AIRCRAFT_PROVIDER, [
      aircraftObs('abc123', iso(day, 0), 50.0, 8.0), aircraftObs('abc123', iso(day, 10), 50.1, 8.1), aircraftObs('abc123', iso(day, 20), 50.2, 8.2),
      aircraftObs('def456', iso(day, 0), -33.9, 151.2), aircraftObs('def456', iso(day, 10), -33.8, 151.3),
    ]));
    out.push(batch(QUAKE_PROVIDER, [quakeObs(`q-${day.slice(0, 10)}`, iso(day, 4 * 3600), 35.0, -118.0, 4.2)]));
  }
  return out;
}

test('partition layout: keys, paths and round-trip parsing', () => {
  const key = partitionKeyFor('aircraft', 'opensky', '2026-09-21T08:42:13.000Z', 60);
  assert.deepEqual(key, { objectType: 'aircraft', providerId: 'opensky', day: '2026-09-21', slot: '0800' });
  assert.equal(partitionRelativePath(key, 'ndjson'), 'aircraft/2026/09/21/opensky-0800.ndjson');
  assert.deepEqual(parsePartitionRelativePath('aircraft/2026/09/21/opensky-0800.ndjson', 'ndjson'), key);
  assert.equal(parsePartitionRelativePath('index.json', 'ndjson'), undefined);
  assert.equal(partitionId(key), 'aircraft/2026-09-21/opensky-0800');
  assert.deepEqual(partitionKeyFor('aircraft', 'adsb-remote', '2026-09-21T23:59:59.999Z', 15).slot, '2345');
  assert.deepEqual(partitionKeyFor('vessel', 'ais', '2026-12-31T00:00:00.000Z', 60), { objectType: 'vessel', providerId: 'ais', day: '2026-12-31', slot: '0000' });
});

test('ndjson backend: conformance suite (append, list, read, availability, objectsAt, track, counts, rewrite, delete)', async () => {
  const dataDir = await tempDir();
  const backend = new NdjsonBackend({ dataDir });
  await runBackendConformance(backend, {
    afterWrite: async () => {
      const file = path.join(dataDir, 'history', 'aircraft', '2026', '09', '20', 'opensky-0800.ndjson');
      const text = await fs.readFile(file, 'utf8');
      assert.equal(text.trim().split('\n').length, 5, 'one JSON line per row in the documented partition path');
      const index = JSON.parse(await fs.readFile(path.join(dataDir, 'history', 'index.json'), 'utf8')) as { version: number; partitions: unknown[] };
      assert.equal(index.version, 1);
      assert.equal(index.partitions.length, 6);
    },
  });
});

test('store: writes for two providers/types across three days; availability exact; objectsAt/lookback; track ordering; snapshot identity', async () => {
  const { store, backend } = await makeStore();
  const receipts = threeDays().map((b) => store.writeBatch(b));
  assert.ok(receipts.every((r) => r.dropped === 0 && r.skippedByPolicy === 0 && r.invalid === 0));
  assert.equal(receipts.reduce((n, r) => n + r.queued, 0), 18);
  await store.flush();
  assert.equal(store.getStats().writtenRows, 18);
  assert.equal(store.getStats().queuedRows, 0);

  const avail = await store.availability(['aircraft', 'earthquake']);
  assert.deepEqual(avail, [
    { objectType: 'aircraft', ranges: [{ start: iso(D1, 0), end: iso(D1, 20) }, { start: iso(D2, 0), end: iso(D2, 20) }, { start: iso(D3, 0), end: iso(D3, 20) }] },
    { objectType: 'earthquake', ranges: [{ start: iso(D1, 4 * 3600), end: iso(D1, 4 * 3600) }, { start: iso(D2, 4 * 3600), end: iso(D2, 4 * 3600) }, { start: iso(D3, 4 * 3600), end: iso(D3, 4 * 3600) }] },
  ]);
  assert.deepEqual((await store.availability(['camera'])), [{ objectType: 'camera', ranges: [] }]);

  const at = await store.objectsAt(iso(D2, 15), { objectTypes: ['aircraft'], lookbackSeconds: 600 });
  assert.deepEqual(at.map((r) => [r.objectId, r.observedAt]), [['aircraft:icao24:abc123', iso(D2, 10)], ['aircraft:icao24:def456', iso(D2, 10)]]);
  assert.equal((await store.objectsAt(iso(D2, 15), { objectTypes: ['aircraft'], lookbackSeconds: 4 })).length, 0);
  assert.equal((await store.objectsAt(iso(D2, 15), { objectTypes: ['aircraft'], lookbackSeconds: 5 })).length, 2, 'boundary is inclusive');

  const track = await store.track('aircraft:icao24:abc123', { start: D1, end: iso(D3, 3600) });
  assert.equal(track.length, 9);
  assert.deepEqual(track[0], { observedAt: iso(D1, 0), latitude: 50.0, longitude: 8.0, altitudeM: 10_000 });
  for (let i = 1; i < track.length; i++) assert.ok(track[i]!.observedAt > track[i - 1]!.observedAt);

  // snapshot reconstruction: deterministic ids, HISTORICAL freshness, historical provenance
  const snap = await store.snapshotAt(iso(D2, 15), { objectTypes: ['aircraft'] });
  assert.equal(snap.length, 2);
  const live = defaultIdentityResolver.resolve(aircraftObs('abc123', iso(D2, 10), 50.1, 8.1)).objectId;
  assert.equal(snap[0]!.id, live, 'replayed object id equals the live id');
  assert.equal(snap[0]!.freshness, 'HISTORICAL');
  assert.equal(snap[0]!.provenance.origin, 'historical');
  assert.equal(snap[0]!.observedAt, iso(D2, 10));
  assert.deepEqual(snap[0]!.position, { latitude: 50.1, longitude: 8.1, altitudeM: 10_000 });
  assert.equal(snap[0]!.labels['callsign'], 'WV123');
  assert.equal(snap[0]!.motion?.speedMps, 230);
  assert.equal(snap[0]!.sourceRefs[0]!.observationId, `opensky:abc123:${iso(D2, 10)}`);
  assert.ok(snap[0]!.confidence > 0 && snap[0]!.confidence < 1);

  // queryObjects serves history.query with region + time range
  const result = await store.queryObjects({ objectTypes: ['aircraft', 'earthquake'], time: { start: D2, end: iso(D2, 5 * 3600) }, region: { kind: 'bounds', bounds: { west: -130, south: 30, east: -110, north: 40 } } });
  assert.equal(result.basis, 'historical');
  assert.deepEqual(result.items.map((o) => o.id), ['earthquake:usgs:q-2026-09-20']);
  assert.equal(result.total, 1);
  assert.equal(result.truncated, false);

  const counts = await store.counts({ range: { start: D1, end: iso(D3, 86_400) }, objectTypes: ['aircraft'] });
  assert.deepEqual(counts, [{ objectType: 'aircraft', objects: 2, rows: 15 }]);
  const rows = await store.observationsInRange({ objectTypes: ['earthquake'], time: { start: D1, end: iso(D3, 86_400) } });
  assert.equal(rows.length, 3);
  assert.equal((await backend.listPartitions()).length, 6);
  await store.close();
});

test('store: policy enforcement — no normalized retention writes nothing, raw hash stripped, maxRetentionSeconds caps', async () => {
  const { store, backend } = await makeStore();
  const denied = store.writeBatch(batch('no-retain', [aircraftObs('aaa111', iso(D3, 0), 1, 1, {}, 'no-retain')]));
  assert.equal(denied.skippedByPolicy, 1);
  assert.equal(denied.queued, 0);
  const noPolicy = store.writeBatch(batch('unknown-provider', [aircraftObs('aaa111', iso(D3, 0), 1, 1, {}, 'unknown-provider')]));
  assert.equal(noPolicy.skippedByPolicy, 1, 'providers without a data policy are never persisted');
  store.writeBatch(batch('no-raw', [aircraftObs('bbb222', iso(D3, 0), 2, 2, {}, 'no-raw')]));
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('ccc333', iso(D3, 0), 3, 3)]));
  store.writeBatch(batch('capped', [aircraftObs('ddd444', iso(D3, 0), 4, 4, {}, 'capped')]));
  const camera = store.writeBatch(batch(AIRCRAFT_PROVIDER, [{ ...aircraftObs('eee555', iso(D3, 0), 5, 5), objectType: 'camera' }]));
  assert.equal(camera.skippedByRetention, 1, 'camera retention is 0 → never stored');
  await store.flush();

  const parts = await backend.listPartitions();
  assert.deepEqual(parts.map((p) => p.providerId).sort(), ['capped', 'no-raw', 'opensky']);
  assert.equal(parts.some((p) => p.providerId === 'no-retain'), false);
  const noRaw = (await backend.readPartition(parts.find((p) => p.providerId === 'no-raw')!)).rows[0]!;
  assert.equal(noRaw.rawPayloadHash, undefined, 'raw hash dropped when rawPayloadRetentionAllowed=false');
  const withRaw = (await backend.readPartition(parts.find((p) => p.providerId === 'opensky')!)).rows[0]!;
  assert.equal(withRaw.rawPayloadHash, `hash-ccc333-${iso(D3, 0)}`);

  assert.equal(store.effectiveRetention('aircraft', 'capped'), 3600, 'provider cap shortens the 30d type default');
  assert.equal(store.effectiveRetention('aircraft', AIRCRAFT_PROVIDER), 30 * 86_400);
  assert.equal(store.effectiveRetention('earthquake', QUAKE_PROVIDER), 'indefinite');
  assert.equal(store.effectiveRetention('earthquake', 'capped'), 3600, 'cap applies even to indefinite types');
  assert.equal(store.effectiveRetention('aircraft', 'no-retain'), 0);
  assert.equal(store.effectiveRetention('aircraft', 'user'), 'indefinite', 'user data is kept indefinitely');
  assert.equal(effectiveRetentionSeconds(retentionPolicyFor('aircraft'), undefined), 0);

  const sweep = await store.sweepRetention(Date.parse(iso(D3, 2 * 3600)));
  assert.deepEqual(sweep.deleted.map((p) => p.providerId), ['capped'], 'capped partition older than 1h deleted, others kept');
  assert.deepEqual((await backend.listPartitions()).map((p) => p.providerId).sort(), ['no-raw', 'opensky']);
  assert.equal(store.getStats().skippedByPolicy, 2);
  assert.equal(store.getStats().skippedByRetention, 1);
  await store.close();
});

test('retention: tier selection and composable downsampling keep first/last and exact every-10th', () => {
  const policy = retentionPolicyFor('aircraft');
  assert.equal(tierForAge(policy, 60), 0);
  assert.equal(tierForAge(policy, 5 * 60), 1);
  assert.equal(tierForAge(policy, 29 * 60), 1);
  assert.equal(tierForAge(policy, 30 * 60), 2);
  assert.equal(tierForAge(policy, 48 * 3600), 2);
  assert.equal(tierForAge(retentionPolicyFor('earthquake'), 1e9), 0, 'non-movement types never downsample');
  const rows: HistoryRow[] = [];
  for (let i = 0; i < 60; i++) rows.push({ observationId: `o${i}`, objectId: 'aircraft:icao24:abc123', providerId: 'p', objectType: 'aircraft', observedAt: iso(D3, i), receivedAt: iso(D3, i), payloadJson: '{}', origin: 'live' });
  const t1 = downsampleRows(rows, TRACK_DOWNSAMPLE_TIERS, 1);
  assert.equal(t1.rows.length, 25, '20 multiples of 3 + 4 extra multiples of 10 + last');
  assert.equal(t1.removed, 35);
  assert.ok(t1.rows.every((r) => r.seq !== undefined));
  const t2 = downsampleRows(t1.rows, TRACK_DOWNSAMPLE_TIERS, 2);
  assert.deepEqual(t2.rows.map((r) => r.seq), [0, 10, 20, 30, 40, 50, 59], 'tier 2 is exactly every 10th of the original plus the last point');
  const direct = downsampleRows(rows.map((r) => ({ ...r })), TRACK_DOWNSAMPLE_TIERS, 2);
  assert.deepEqual(direct.rows.map((r) => r.seq), t2.rows.map((r) => r.seq), 'tier 1 → tier 2 equals direct tier 2');
  const userRows = rows.slice(0, 10).map((r) => ({ ...r, origin: 'user' as const }));
  assert.equal(downsampleRows(userRows, TRACK_DOWNSAMPLE_TIERS, 2).removed, 0, 'user rows are never thinned');
});

test('store: retention sweep deletes expired partitions and downsamples aircraft in tiers while the index keeps original counts', async () => {
  const { store, backend } = await makeStore();
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push(aircraftObs('abc123', iso(D3, i), 50 + i * 0.001, 8));
  store.writeBatch(batch(AIRCRAFT_PROVIDER, pts));
  // 29 d 14 h old: inside the 30 d window until the +25 h sweep below.
  const oldAt = iso(D3, -(30 * 86_400 - 10 * 3600));
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('old999', oldAt, 1, 1)]));
  store.writeBatch(batch(QUAKE_PROVIDER, [quakeObs('ancient', '2020-01-01T00:00:00.000Z', 35, -118, 5.0)]));
  await store.flush();
  const key: PartitionKey = partitionKeyFor('aircraft', AIRCRAFT_PROVIDER, iso(D3, 0));
  const oldKey = partitionKeyFor('aircraft', AIRCRAFT_PROVIDER, oldAt);

  const fresh = await store.sweepRetention(Date.parse(iso(D3, 90)));
  assert.ok(fresh.rewritten.every((r) => r.partition.id !== partitionId(key)), 'younger than 5 min: untouched');
  assert.deepEqual(fresh.deleted, []);
  const old = fresh.rewritten.find((r) => r.partition.id === partitionId(oldKey))!;
  assert.equal(old.tier, 2, 'a month-old aircraft partition goes straight to the coarsest tier');
  assert.equal(old.rawStripped, 1, 'and loses its raw hash (older than 24 h)');
  assert.equal(old.rowsAfter, 1, 'first/last point of an object is always kept');

  const s1 = await store.sweepRetention(Date.parse(iso(D3, 59 + 5 * 60)));
  assert.equal(s1.rewritten.length, 1);
  assert.equal(s1.rewritten[0]!.partition.id, partitionId(key));
  assert.equal(s1.rewritten[0]!.tier, 1);
  assert.equal(s1.rewritten[0]!.rowsBefore, 60);
  assert.equal(s1.rewritten[0]!.rowsAfter, 25);
  let meta = (await backend.listPartitions()).find((p) => p.id === partitionId(key))!;
  assert.equal(meta.rows, 25);
  assert.equal(meta.originalRows, 60, 'nothing lost without a record');
  assert.equal(meta.downsampleTier, 1);
  assert.equal((await backend.readPartition(key)).rows.length, 25);
  assert.equal((await store.sweepRetention(Date.parse(iso(D3, 59 + 6 * 60)))).rewritten.length, 0, 'same tier: no rewrite');

  const s2 = await store.sweepRetention(Date.parse(iso(D3, 59 + 30 * 60)));
  assert.equal(s2.rewritten[0]!.tier, 2);
  assert.equal(s2.rewritten[0]!.rowsAfter, 7);
  meta = (await backend.listPartitions()).find((p) => p.id === partitionId(key))!;
  assert.equal(meta.rows, 7);
  assert.equal(meta.originalRows, 60);
  const track = await store.track('aircraft:icao24:abc123', { start: iso(D3, 0), end: iso(D3, 60) });
  assert.deepEqual(track.map((t) => t.observedAt), [0, 10, 20, 30, 40, 50, 59].map((s) => iso(D3, s)));
  assert.ok((await backend.readPartition(key)).rows.every((r) => r.rawPayloadHash !== undefined), 'raw hash kept inside 24h');

  const s3 = await store.sweepRetention(Date.parse(iso(D3, 25 * 3600)));
  assert.equal(s3.rewritten.length, 1);
  assert.equal(s3.rewritten[0]!.rawStripped, 7);
  meta = (await backend.listPartitions()).find((p) => p.id === partitionId(key))!;
  assert.equal(meta.rawStripped, true);
  assert.equal(meta.rows, 7);
  assert.ok((await backend.readPartition(key)).rows.every((r) => r.rawPayloadHash === undefined), 'raw hash stripped after 24h');
  assert.deepEqual(s3.deleted.map((p) => p.id), [partitionId(oldKey)], 'aircraft partition older than 30d deleted; indefinite earthquake kept');
  const remaining = await backend.listPartitions();
  assert.deepEqual(remaining.map((p) => p.objectType).sort(), ['aircraft', 'earthquake']);
  assert.equal(remaining.find((p) => p.objectType === 'earthquake')!.day, '2020-01-01');
  assert.equal(s3.errors.length, 0);
  await store.close();
});

test('ndjson backend: malformed lines are counted and skipped, never fatal', async () => {
  const { store, backend, dataDir, sink } = await makeStore();
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(D3, 0), 50, 8), aircraftObs('abc123', iso(D3, 10), 50.1, 8.1)]));
  await store.flush();
  const file = path.join(dataDir, 'history', 'aircraft', '2026', '09', '21', 'opensky-0800.ndjson');
  await fs.appendFile(file, '{not json at all\n{"observationId": 1}\n\n{"observationId":"x","objectId":"y","providerId":"p","objectType":"t","observedAt":"nope","receivedAt":"nope","payloadJson":"{}","origin":"live"}\n');
  const key = partitionKeyFor('aircraft', AIRCRAFT_PROVIDER, iso(D3, 0));
  const read = await backend.readPartition(key);
  assert.equal(read.rows.length, 2);
  assert.equal(read.malformed, 3);
  const at = await store.objectsAt(iso(D3, 30), { objectTypes: ['aircraft'], lookbackSeconds: 60 });
  assert.equal(at.length, 1);
  assert.equal(at[0]!.observedAt, iso(D3, 10));
  assert.ok(sink.records.some((r) => r.level === 'warn' && r.message.includes('malformed')));
  const diag = await store.diagnostics();
  assert.equal(diag.details?.['malformedRowsSkipped'], 6, 'two reads × three bad lines');
  assert.equal(lineToRow('garbage'), undefined);
  assert.equal(lineToRow(''), undefined);
  await store.close();
});

test('ndjson backend: index rebuilt when index.json is missing and reconciled when files are ahead of it', async () => {
  const { store, dataDir } = await makeStore();
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(D3, 0), 50, 8), aircraftObs('abc123', iso(D3, 10), 50.1, 8.1)]));
  await store.flush();
  await store.close();
  const indexFile = path.join(dataDir, 'history', 'index.json');
  const committed = await fs.readFile(indexFile, 'utf8');
  await fs.rm(indexFile);
  const reopened = new NdjsonBackend({ dataDir });
  await reopened.open();
  const parts = await reopened.listPartitions();
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.rows, 2);
  assert.equal(parts[0]!.minObservedAt, iso(D3, 0));
  assert.equal(parts[0]!.maxObservedAt, iso(D3, 10));
  assert.deepEqual(await reopened.availability(['aircraft']), [{ objectType: 'aircraft', ranges: [{ start: iso(D3, 0), end: iso(D3, 10) }] }]);
  await reopened.close();
  assert.ok(await fs.stat(indexFile), 'rebuilt index committed');

  // Crash inside the index write window: rows on disk the committed index does not know about, and an entry whose file is gone.
  const key = partitionKeyFor('aircraft', AIRCRAFT_PROVIDER, iso(D3, 0));
  const { row } = rowsFor([aircraftObs('abc123', iso(D3, 20), 50.2, 8.2)])[0]!;
  await fs.appendFile(path.join(dataDir, 'history', 'aircraft', '2026', '09', '21', 'opensky-0800.ndjson'), JSON.stringify(row) + '\n');
  const stale = JSON.parse(committed) as { partitions: Array<Record<string, unknown>> };
  stale.partitions.push({ ...stale.partitions[0]!, id: 'aircraft/2026-09-22/opensky-0800', day: '2026-09-22', minObservedAt: iso(D3, 86_400), maxObservedAt: iso(D3, 86_400) });
  await fs.writeFile(indexFile, JSON.stringify(stale));
  const again = new NdjsonBackend({ dataDir });
  await again.open();
  const fixed = await again.listPartitions();
  assert.equal(fixed.length, 1, 'entry without a file dropped');
  assert.equal(fixed[0]!.id, partitionId(key));
  assert.equal(fixed[0]!.rows, 3, 'uncommitted appended row picked up');
  assert.equal(fixed[0]!.originalRows, 3);
  assert.equal(fixed[0]!.maxObservedAt, iso(D3, 20));
  await again.close();
});

test('store: sweep never destroys partitions of a provider whose policy is unknown right now', async () => {
  const { store, backend } = await makeStore();
  store.writeBatch(batch('capped', [aircraftObs('abc123', iso(D3, -86_400), 50, 8, {}, 'capped')]));
  await store.flush();
  const gone = new HistoryStore({ dataDir: store.dataDir, backend, policies: () => undefined });
  const report = await gone.sweepRetention(Date.parse(iso(D3, 3600)));
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(report.skipped, [{ partition: 'aircraft/2026-09-20/capped-0800', reason: 'no data policy for provider' }]);
  assert.equal((await backend.listPartitions()).length, 1);
  const back = await store.sweepRetention(Date.parse(iso(D3, 3600)));
  assert.equal(back.deleted.length, 1, 'with the policy known again the 1 h cap applies');
  await store.close();
});

test('store: bounded queue drops with a count and a log line when the backend is slow; writes never block', async () => {
  const dataDir = await tempDir();
  const clock = new VirtualClock(Date.parse(D3));
  const { hub, sink } = makeLogger();
  const inner = new NdjsonBackend({ dataDir, clock });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let appends = 0;
  const slow: HistoryBackend = wrapBackend(inner, {
    append: async (key: PartitionKey, rows: HistoryRow[]) => { appends++; await gate; return inner.append(key, rows); },
  });
  const store = new HistoryStore({ dataDir, backend: slow, clock, logger: hub.logger('history'), policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY }), maxQueuedRows: 10 });
  await store.open();
  const mk = (n: number, offset: number) => Array.from({ length: n }, (_, i) => aircraftObs(`a${String(offset + i).padStart(5, '0')}`, iso(D3, offset + i), 10, 10));
  const r1 = store.writeBatch(batch(AIRCRAFT_PROVIDER, mk(10, 0)));
  assert.equal(r1.queued, 10);
  assert.equal(appends, 1, 'drain started immediately without blocking the caller');
  const r2 = store.writeBatch(batch(AIRCRAFT_PROVIDER, mk(10, 100)));
  assert.equal(r2.queued, 10);
  assert.equal(r2.dropped, 0);
  const r3 = store.writeBatch(batch(AIRCRAFT_PROVIDER, mk(15, 200)));
  assert.equal(r3.queued, 0);
  assert.equal(r3.dropped, 15);
  assert.equal(store.getStats().droppedRows, 15);
  assert.ok(sink.records.some((r) => r.level === 'warn' && r.message.includes('queue full')), 'overflow is logged');
  release!();
  await store.flush();
  assert.equal(store.getStats().writtenRows, 20);
  assert.equal(store.getStats().queuedRows, 0);
  assert.equal(appends, 2);
  await store.close();
});

test('timeline controller: replay advances at 60x, auto-live at now, jump-to-live, availability from the store only', async () => {
  const { store, clock } = await makeStore();
  const states: string[] = [];
  const timeline = new TimelineController({ history: store, clock, rangeSeconds: 6 * 3600, onChange: (s) => states.push(`${s.mode}@${s.cursor}`) });
  assert.equal(timeline.state().mode, 'LIVE');
  assert.equal(timeline.state().cursor, new Date(clock.now()).toISOString());
  assert.deepEqual(timeline.state().availability, []);
  assert.deepEqual(await timeline.refreshAvailability(), [], 'empty store → no availability claimed');

  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(D3, 0), 50, 8), aircraftObs('abc123', iso(D3, 600), 50.1, 8.1)]));
  await store.flush();
  const avail = await timeline.refreshAvailability();
  assert.deepEqual(avail, [{ objectType: 'aircraft', ranges: [{ start: iso(D3, 0), end: iso(D3, 600) }] }]);
  assert.deepEqual(timeline.state().availability, avail);

  const t0 = clock.now(); // = D3 + 1 h
  timeline.set({ mode: 'REPLAY', cursor: new Date(t0 - 7200_000).toISOString(), speed: 60 });
  assert.equal(timeline.state().mode, 'REPLAY');
  clock.advance(1000);
  const s1 = timeline.tick();
  assert.equal(s1?.cursor, new Date(t0 - 7200_000 + 60_000).toISOString(), '1 s real → 60 s replay');
  clock.advance(10_000);
  const s2 = timeline.tick(clock.now());
  assert.equal(s2?.cursor, new Date(t0 - 7200_000 + 60_000 + 600_000).toISOString());
  assert.equal(s2?.mode, 'REPLAY');
  const snap = await timeline.snapshotAt();
  assert.equal(snap.length, 0, 'cursor before the data window → nothing, no invention');
  timeline.set({ cursor: iso(D3, 300) });
  assert.equal(timeline.state().mode, 'REPLAY', 'cursor scrub keeps replay mode');
  const snap2 = await timeline.snapshotAt();
  assert.equal(snap2.length, 1);
  assert.equal(snap2[0]!.observedAt, iso(D3, 0));
  assert.equal(snap2[0]!.freshness, 'HISTORICAL');
  clock.advance(59_000);
  timeline.tick();
  clock.advance(3600_000);
  const caught = timeline.tick();
  assert.equal(caught?.mode, 'LIVE', 'replay that reaches now becomes LIVE');
  assert.equal(caught?.cursor, new Date(clock.now()).toISOString());

  timeline.pause();
  assert.equal(timeline.state().mode, 'PAUSED');
  clock.advance(5000);
  assert.equal(timeline.tick(), undefined, 'paused cursor does not move');
  timeline.set({ mode: 'HISTORICAL', cursor: iso(D3, 100) });
  assert.equal(timeline.state().cursor, iso(D3, 100));
  const live = timeline.jumpToLive();
  assert.equal(live.mode, 'LIVE');
  assert.equal(live.cursor, new Date(clock.now()).toISOString());
  assert.equal(live.range.end, live.cursor, 'visible range follows now after jump-to-live');
  assert.throws(() => timeline.set({ speed: 3 as unknown as 5 }), /invalid timeline speed/);
  assert.throws(() => timeline.set({ cursor: 'yesterday' }), /invalid timeline cursor/);
  const future = timeline.set({ mode: 'HISTORICAL', cursor: new Date(clock.now() + 86_400_000).toISOString() });
  assert.equal(future.cursor, new Date(clock.now()).toISOString(), 'cursor is clamped to now');
  assert.ok(states.length >= 8);
  assert.ok(states[0]!.startsWith('LIVE@') || states[0]!.startsWith('REPLAY@'));
  await store.close();
});

test('createHistoryBackend: ndjson default; row → observation round trip', async () => {
  const dataDir = await tempDir();
  const created = await createHistoryBackend({ dataDir });
  assert.equal(created.backend.kind, 'ndjson');
  assert.equal(created.requestedBackend, 'ndjson');
  assert.equal(created.fallbackReason, undefined);
  await created.backend.close();
  const obs = quakeObs('us7000abcd', iso(D3, 0), 35, -118, 5.1);
  const { row } = rowsFor([obs])[0]!;
  const back = rowToObservation(row, { sourceName: 'USGS Earthquake Hazards Program', attribution: 'USGS' });
  assert.equal(back.id, obs.id);
  assert.equal(back.externalId, 'us7000abcd');
  assert.deepEqual(back.payload, obs.payload);
  assert.deepEqual(back.position, { latitude: 35, longitude: -118 });
  assert.equal(back.provenance.origin, 'historical');
  assert.equal(back.provenance.sourceName, 'USGS Earthquake Hazards Program');
  assert.equal(back.rawPayloadHash, 'hash-us7000abcd');
  assert.equal(defaultIdentityResolver.resolve(back).objectId, 'earthquake:usgs:us7000abcd');
});

test('performance smoke: 20k rows write + query under 5 s (ndjson)', async () => {
  const { store } = await makeStore();
  const started = Date.now();
  const batches = [];
  for (let b = 0; b < 20; b++) {
    const obs = [];
    for (let i = 0; i < 1000; i++) {
      const ac = `a${String(i % 250).padStart(5, '0')}`;
      obs.push(aircraftObs(ac, iso(D3, b * 60 + Math.floor(i / 250) * 15), 40 + (i % 50) * 0.1, -100 + (i % 70) * 0.1));
    }
    batches.push(batch(AIRCRAFT_PROVIDER, obs));
  }
  for (const b of batches) store.writeBatch(b);
  await store.flush();
  const wrote = Date.now() - started;
  assert.equal(store.getStats().writtenRows, 20_000);
  assert.equal(store.getStats().droppedRows, 0);
  const at = await store.objectsAt(iso(D3, 1500), { objectTypes: ['aircraft'], lookbackSeconds: 600 });
  assert.equal(at.length, 250);
  const track = await store.track('aircraft:icao24:a00007', { start: iso(D3, 0), end: iso(D3, 3600) });
  assert.equal(track.length, 80);
  const avail = await store.availability(['aircraft']);
  assert.equal(avail[0]!.ranges.length, 1);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `20k rows write+query took ${elapsed} ms (write ${wrote} ms)`);
  await store.close();
});
