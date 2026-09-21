import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { HistoryBackend, HistoryRow, PartitionKey } from '../../src/index.js';
import { partitionId } from '../../src/index.js';
import { aircraftObs, quakeObs, rowsFor, iso } from './fixtures.js';

/**
 * Backend conformance: the same assertions run against NdjsonBackend (always) and
 * DuckDbParquetBackend (when the native module is installed). Any backend that passes
 * this can sit behind HistoryStore.
 */
export async function runBackendConformance(backend: HistoryBackend, opts: { afterWrite?: () => Promise<void> } = {}): Promise<void> {
  await backend.open();
  const D1 = '2026-09-19T08:00:00.000Z', D2 = '2026-09-20T08:00:00.000Z', D3 = '2026-09-21T08:00:00.000Z';
  const groups = new Map<string, { key: PartitionKey; rows: HistoryRow[] }>();
  const add = (list: ReturnType<typeof rowsFor>) => {
    for (const { key, row } of list) {
      const id = partitionId(key);
      const g = groups.get(id) ?? { key, rows: [] };
      g.rows.push(row);
      groups.set(id, g);
    }
  };
  for (const day of [D1, D2, D3]) {
    add(rowsFor([
      aircraftObs('abc123', iso(day, 0), 50.0, 8.0), aircraftObs('abc123', iso(day, 10), 50.1, 8.1), aircraftObs('abc123', iso(day, 20), 50.2, 8.2),
      aircraftObs('def456', iso(day, 0), -33.9, 151.2), aircraftObs('def456', iso(day, 10), -33.8, 151.3),
    ]));
    add(rowsFor([quakeObs(`q-${day.slice(0, 10)}`, iso(day, 4 * 3600), 35.0, -118.0, 4.2)]));
  }
  for (const g of groups.values()) {
    const res = await backend.append(g.key, g.rows);
    assert.equal(res.rows, g.rows.length);
    assert.ok(res.bytes > 0);
    assert.equal(res.partition.rows, g.rows.length);
  }
  await backend.flush();
  await opts.afterWrite?.();

  // Partition list + metadata
  const parts = await backend.listPartitions();
  assert.equal(parts.length, 6, 'three aircraft + three earthquake partitions');
  const aircraftParts = await backend.listPartitions({ objectTypes: ['aircraft'] });
  assert.equal(aircraftParts.length, 3);
  assert.deepEqual(aircraftParts.map((p) => p.day), ['2026-09-19', '2026-09-20', '2026-09-21']);
  assert.equal(aircraftParts[0]!.minObservedAt, iso(D1, 0));
  assert.equal(aircraftParts[0]!.maxObservedAt, iso(D1, 20));
  assert.equal(aircraftParts[0]!.originalRows, 5);

  // Read partition
  const read = await backend.readPartition(aircraftParts[1]!);
  assert.equal(read.rows.length, 5);
  assert.equal(read.malformed, 0);
  assert.ok(read.rows.every((r) => r.objectType === 'aircraft' && r.providerId === 'opensky'));
  const first = read.rows.find((r) => r.observationId === `opensky:abc123:${iso(D2, 0)}`);
  assert.ok(first, 'row round-trips through the backend');
  assert.equal(first.lat, 50.0);
  assert.equal(first.lon, 8.0);
  assert.equal(first.altitudeM, 10_000);
  assert.equal(first.rawPayloadHash, `hash-abc123-${iso(D2, 0)}`);
  assert.equal(first.sourceQuality, 'crowdsourced');
  assert.equal(first.externalId, 'abc123');
  assert.deepEqual(JSON.parse(first.payloadJson).icao24, 'abc123');

  // availability: exact boundaries, three separate days (gap > tolerance)
  const avail = await backend.availability(['aircraft', 'earthquake', 'vessel']);
  assert.deepEqual(avail.map((a) => a.objectType), ['aircraft', 'earthquake', 'vessel']);
  const air = avail.find((a) => a.objectType === 'aircraft')!;
  assert.deepEqual(air.ranges, [
    { start: iso(D1, 0), end: iso(D1, 20) }, { start: iso(D2, 0), end: iso(D2, 20) }, { start: iso(D3, 0), end: iso(D3, 20) },
  ]);
  assert.deepEqual(avail.find((a) => a.objectType === 'vessel')!.ranges, [], 'no partitions → no availability');

  // objectsAt: latest ≤ cursor within lookback
  const at = await backend.objectsAt(iso(D2, 15), { objectTypes: ['aircraft'], lookbackSeconds: 600 });
  assert.deepEqual(at.map((r) => [r.objectId, r.observedAt]), [['aircraft:icao24:abc123', iso(D2, 10)], ['aircraft:icao24:def456', iso(D2, 10)]]);
  const tight = await backend.objectsAt(iso(D2, 15), { objectTypes: ['aircraft'], lookbackSeconds: 3 });
  assert.equal(tight.length, 0, 'lookback excludes observations older than cursor − lookback');
  const exact = await backend.objectsAt(iso(D2, 20), { objectTypes: ['aircraft'], lookbackSeconds: 0 });
  assert.deepEqual(exact.map((r) => r.objectId), ['aircraft:icao24:abc123'], 'cursor equal to observedAt is included');
  const bounded = await backend.objectsAt(iso(D2, 30), { objectTypes: ['aircraft'], lookbackSeconds: 600, bounds: { west: 150, south: -40, east: 160, north: -30 } });
  assert.deepEqual(bounded.map((r) => r.objectId), ['aircraft:icao24:def456']);
  const all = await backend.objectsAt(iso(D3, 5 * 3600), { lookbackSeconds: 3 * 86_400 });
  assert.deepEqual(all.map((r) => r.objectId).sort(), ['aircraft:icao24:abc123', 'aircraft:icao24:def456', 'earthquake:usgs:q-2026-09-19', 'earthquake:usgs:q-2026-09-20', 'earthquake:usgs:q-2026-09-21']);

  // track ordering
  const track = await backend.track('aircraft:icao24:abc123', { start: D1, end: iso(D3, 3600) });
  assert.equal(track.length, 9);
  for (let i = 1; i < track.length; i++) assert.ok(track[i]!.observedAt > track[i - 1]!.observedAt, 'track ascending');
  assert.equal((await backend.track('aircraft:icao24:abc123', { start: D2, end: iso(D2, 10) })).length, 2);

  // counts and observationsInRange
  const counts = await backend.counts({ range: { start: D1, end: iso(D3, 86_400) }, objectTypes: ['aircraft', 'earthquake'] });
  assert.deepEqual(counts, [{ objectType: 'aircraft', objects: 2, rows: 15 }, { objectType: 'earthquake', objects: 3, rows: 3 }]);
  const regionCounts = await backend.counts({ range: { start: D1, end: iso(D3, 86_400) }, region: { kind: 'circle', center: { latitude: 35, longitude: -118 }, radiusM: 10_000 } });
  assert.deepEqual(regionCounts, [{ objectType: 'earthquake', objects: 3, rows: 3 }]);
  const inRange = await backend.observationsInRange({ range: { start: iso(D2, 0), end: iso(D2, 10) }, objectTypes: ['aircraft'], providerIds: ['opensky'] });
  assert.equal(inRange.length, 4);
  assert.ok(inRange[0]!.observedAt <= inRange[3]!.observedAt);
  assert.equal((await backend.observationsInRange({ range: { start: D1, end: iso(D3, 86_400) }, limit: 2 })).length, 2);

  // rewrite keeps originalRows; delete removes files and metadata
  const p1 = aircraftParts[0]!;
  const keep = read.rows.slice(0, 2).map((r) => ({ ...r, objectType: p1.objectType, providerId: p1.providerId }));
  const rewritten = await backend.rewritePartition(p1, keep, { originalRows: p1.originalRows, downsampleTier: 1 });
  assert.equal(rewritten.rows, 2);
  assert.equal(rewritten.originalRows, 5);
  assert.equal(rewritten.downsampleTier, 1);
  assert.equal((await backend.readPartition(p1)).rows.length, 2);
  assert.equal(await backend.deletePartition(p1), true);
  assert.equal(await backend.deletePartition(p1), false);
  assert.equal((await backend.listPartitions({ objectTypes: ['aircraft'] })).length, 2);
  assert.equal((await backend.readPartition(p1)).rows.length, 0, 'deleted partition reads as empty');
  const diag = await backend.diagnostics();
  assert.equal(diag.partitions, 5);
  assert.ok(diag.sizeBytes > 0);
  await backend.close();
}

export async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
