import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DuckDbParquetBackend,
  NdjsonBackend,
  type HistoryRow,
  HistoryBackendUnavailableError,
  isHistoryBackendUnavailable,
  type DuckDbModule,
} from './index.js';
import { runBackendConformance, fileExists } from '../test/helpers/backend-conformance.js';
import { tempDir } from '../test/helpers/fixtures.js';

/**
 * DuckDB/Parquet backend tests. They run for real when `@duckdb/node-api` is installed
 * and are SKIPPED (with the load error as the reason) when it is not — never faked.
 */
let duckdb: DuckDbModule | undefined;
let skipReason: string | false = false;
try {
  duckdb = await import('@duckdb/node-api');
} catch (err) {
  skipReason = `@duckdb/node-api not installed in this environment: ${(err as Error).message.split('\n')[0]}`;
}

test('duckdb-parquet: unavailable module surfaces a typed HistoryBackendUnavailableError (always runs)', async () => {
  const backend = new DuckDbParquetBackend({
    dataDir: await tempDir(),
    loadModule: async () => {
      throw new HistoryBackendUnavailableError('duckdb-parquet', 'simulated: module not found');
    },
  });
  await assert.rejects(
    backend.open(),
    (err: unknown) =>
      isHistoryBackendUnavailable(err) &&
      (err as HistoryBackendUnavailableError).reason === 'simulated: module not found',
  );
  const broken = new DuckDbParquetBackend({
    dataDir: await tempDir(),
    loadModule: async () =>
      ({
        DuckDBInstance: {
          create: async () => {
            throw new Error('native init failed');
          },
        },
      }) as unknown as DuckDbModule,
  });
  await assert.rejects(
    broken.open(),
    (err: unknown) => isHistoryBackendUnavailable(err) && /native init failed/.test((err as Error).message),
  );
});

test('duckdb-parquet: conformance suite over Parquet partitions', { skip: skipReason }, async () => {
  const dataDir = await tempDir('worldview-duckdb-');
  const backend = new DuckDbParquetBackend({
    dataDir,
    rollRows: 3,
    rollSeconds: 3600,
    loadModule: async () => duckdb!,
  });
  await runBackendConformance(backend, {
    afterWrite: async () => {
      // Partitions with ≥ rollRows rows rolled on append; flush() rolled the 1-row earthquake partitions too.
      assert.ok(
        await fileExists(path.join(dataDir, 'history', 'aircraft', '2026', '09', '20', 'opensky-0800.parquet')),
      );
      assert.ok(
        await fileExists(
          path.join(dataDir, 'history', 'earthquake', '2026', '09', '20', 'usgs-earthquakes-1200.parquet'),
        ),
      );
      assert.equal(
        await fileExists(
          path.join(dataDir, 'history', 'earthquake', '2026', '09', '20', 'usgs-earthquakes-1200.staging.ndjson'),
        ),
        false,
      );
      const diag = await backend.diagnostics();
      assert.equal(diag.kind, 'duckdb-parquet');
      assert.equal(
        typeof diag.details?.['spatialExtension'],
        'boolean',
        'records whether the spatial extension loaded',
      );
    },
  });
});

test('duckdb-parquet: staging rows are rolled on close and recovered on reopen', { skip: skipReason }, async () => {
  const dataDir = await tempDir('worldview-duckdb-');
  const backend = new DuckDbParquetBackend({
    dataDir,
    rollRows: 1000,
    rollSeconds: 3600,
    loadModule: async () => duckdb!,
  });
  await backend.open();
  const key = { objectType: 'earthquake', providerId: 'usgs-earthquakes', day: '2026-09-21', slot: '0800' };
  await backend.append(key, [
    {
      observationId: 'usgs-earthquakes:q1:2026-09-21T08:00:00.000Z',
      objectId: 'earthquake:usgs:q1',
      providerId: 'usgs-earthquakes',
      objectType: 'earthquake',
      observedAt: '2026-09-21T08:00:00.000Z',
      receivedAt: '2026-09-21T08:00:00.000Z',
      lat: 35,
      lon: -118,
      payloadJson: '{"magnitude":4}',
      origin: 'live',
    },
  ]);
  const staging = path.join(
    dataDir,
    'history',
    'earthquake',
    '2026',
    '09',
    '21',
    'usgs-earthquakes-0800.staging.ndjson',
  );
  assert.ok(await fileExists(staging));
  await backend.close();
  assert.equal(await fileExists(staging), false, 'close rolls staging into parquet');
  assert.ok(
    await fileExists(path.join(dataDir, 'history', 'earthquake', '2026', '09', '21', 'usgs-earthquakes-0800.parquet')),
  );
  // Simulate a crash with unrolled staging rows, then reopen.
  await fs.appendFile(
    staging,
    JSON.stringify({
      observationId: 'usgs-earthquakes:q2:2026-09-21T08:30:00.000Z',
      objectId: 'earthquake:usgs:q2',
      providerId: 'usgs-earthquakes',
      objectType: 'earthquake',
      observedAt: '2026-09-21T08:30:00.000Z',
      receivedAt: '2026-09-21T08:30:00.000Z',
      lat: 36,
      lon: -119,
      payloadJson: '{"magnitude":5}',
      origin: 'live',
    }) + '\n',
  );
  const reopened = new DuckDbParquetBackend({ dataDir, loadModule: async () => duckdb! });
  await reopened.open();
  assert.equal(await fileExists(staging), false, 'startup recovery rolls leftover staging');
  const rows = (await reopened.readPartition(key)).rows;
  assert.deepEqual(rows.map((r) => r.objectId).sort(), ['earthquake:usgs:q1', 'earthquake:usgs:q2']);
  await reopened.close();
});

test(
  'duckdb-parquet: history the NDJSON backend wrote is read beside Parquet, never converted or deleted on open',
  { skip: skipReason },
  async () => {
    const dataDir = await tempDir('worldview-duckdb-legacy-');
    const row = (id: string, at: string): HistoryRow => ({
      observationId: `celestrak:${id}:${at}`,
      objectId: `satellite:norad:${id}`,
      providerId: 'celestrak',
      objectType: 'satellite',
      observedAt: at,
      receivedAt: at,
      lat: 10,
      lon: 20,
      payloadJson: '{}',
      origin: 'live',
    });
    const key = { objectType: 'satellite', providerId: 'celestrak', day: '2026-09-21', slot: '0800' };
    const old = { objectType: 'satellite', providerId: 'celestrak', day: '2026-09-20', slot: '0800' };
    const ndjson = new NdjsonBackend({ dataDir });
    await ndjson.open();
    await ndjson.append(key, [row('1', '2026-09-21T08:00:00.000Z'), row('2', '2026-09-21T08:05:00.000Z')]);
    await ndjson.append(old, [row('3', '2026-09-20T08:00:00.000Z')]);
    await ndjson.close();
    const legacyFile = path.join(dataDir, 'history', 'satellite', '2026', '09', '21', 'celestrak-0800.ndjson');
    const oldFile = path.join(dataDir, 'history', 'satellite', '2026', '09', '20', 'celestrak-0800.ndjson');
    const legacyBytes = (await fs.stat(legacyFile)).size;

    const backend = new DuckDbParquetBackend({
      dataDir,
      rollRows: 1,
      rollSeconds: 3600,
      loadModule: async () => duckdb!,
    });
    await backend.open();
    assert.ok(await fileExists(legacyFile), 'left where it is');
    assert.equal((await backend.listPartitions()).length, 2, 'the index keeps the NDJSON partitions');
    // New rows for the same hour go to Parquet; the old rows are read beside them.
    await backend.append(key, [row('1', '2026-09-21T08:10:00.000Z')]);
    const meta = (await backend.listPartitions()).find((m) => m.day === '2026-09-21')!;
    assert.ok(meta.bytes > legacyBytes, 'the NDJSON file still counts toward the size cap');
    const at = await backend.objectsAt('2026-09-21T09:00:00.000Z', { lookbackSeconds: 2 * 86_400 });
    assert.deepEqual(
      at.map((r) => [r.objectId, r.observedAt]),
      [
        ['satellite:norad:1', '2026-09-21T08:10:00.000Z'],
        ['satellite:norad:2', '2026-09-21T08:05:00.000Z'],
        ['satellite:norad:3', '2026-09-20T08:00:00.000Z'],
      ],
    );
    const track = await backend.track('satellite:norad:1', {
      start: '2026-09-21T00:00:00.000Z',
      end: '2026-09-21T23:59:59.000Z',
    });
    assert.deepEqual(
      track.map((r) => r.observedAt),
      ['2026-09-21T08:00:00.000Z', '2026-09-21T08:10:00.000Z'],
    );
    assert.equal((await backend.readPartition(key)).rows.length, 3);
    const counts = await backend.counts({
      range: { start: '2026-09-20T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' },
    });
    assert.equal(counts.find((c) => c.objectType === 'satellite')?.rows, 4);
    // Retention deleting a partition takes its NDJSON file with it.
    await backend.deletePartition(old);
    assert.equal(await fileExists(oldFile), false);
    // A rewrite moves the NDJSON rows into Parquet (they came in through readPartition).
    const all = (await backend.readPartition(key)).rows;
    await backend.rewritePartition(key, all, { originalRows: all.length });
    assert.equal(await fileExists(legacyFile), false, 'moved, not lost');
    assert.equal((await backend.readPartition(key)).rows.length, 3);
    await backend.close();
  },
);
