import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DuckDbParquetBackend, HistoryBackendUnavailableError, isHistoryBackendUnavailable, type DuckDbModule } from './index.js';
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
  const backend = new DuckDbParquetBackend({ dataDir: await tempDir(), loadModule: async () => { throw new HistoryBackendUnavailableError('duckdb-parquet', 'simulated: module not found'); } });
  await assert.rejects(backend.open(), (err: unknown) => isHistoryBackendUnavailable(err) && (err as HistoryBackendUnavailableError).reason === 'simulated: module not found');
  const broken = new DuckDbParquetBackend({ dataDir: await tempDir(), loadModule: async () => ({ DuckDBInstance: { create: async () => { throw new Error('native init failed'); } } }) as unknown as DuckDbModule });
  await assert.rejects(broken.open(), (err: unknown) => isHistoryBackendUnavailable(err) && /native init failed/.test((err as Error).message));
});

test('duckdb-parquet: conformance suite over Parquet partitions', { skip: skipReason }, async () => {
  const dataDir = await tempDir('worldview-duckdb-');
  const backend = new DuckDbParquetBackend({ dataDir, rollRows: 3, rollSeconds: 3600, loadModule: async () => duckdb! });
  await runBackendConformance(backend, {
    afterWrite: async () => {
      // Partitions with ≥ rollRows rows rolled on append; flush() rolled the 1-row earthquake partitions too.
      assert.ok(await fileExists(path.join(dataDir, 'history', 'aircraft', '2026', '09', '20', 'opensky-0800.parquet')));
      assert.ok(await fileExists(path.join(dataDir, 'history', 'earthquake', '2026', '09', '20', 'usgs-earthquakes-1200.parquet')));
      assert.equal(await fileExists(path.join(dataDir, 'history', 'earthquake', '2026', '09', '20', 'usgs-earthquakes-1200.staging.ndjson')), false);
      const diag = await backend.diagnostics();
      assert.equal(diag.kind, 'duckdb-parquet');
      assert.equal(typeof diag.details?.['spatialExtension'], 'boolean', 'records whether the spatial extension loaded');
    },
  });
});

test('duckdb-parquet: staging rows are rolled on close and recovered on reopen', { skip: skipReason }, async () => {
  const dataDir = await tempDir('worldview-duckdb-');
  const backend = new DuckDbParquetBackend({ dataDir, rollRows: 1000, rollSeconds: 3600, loadModule: async () => duckdb! });
  await backend.open();
  const key = { objectType: 'earthquake', providerId: 'usgs-earthquakes', day: '2026-09-21', slot: '0800' };
  await backend.append(key, [{ observationId: 'usgs-earthquakes:q1:2026-09-21T08:00:00.000Z', objectId: 'earthquake:usgs:q1', providerId: 'usgs-earthquakes', objectType: 'earthquake', observedAt: '2026-09-21T08:00:00.000Z', receivedAt: '2026-09-21T08:00:00.000Z', lat: 35, lon: -118, payloadJson: '{"magnitude":4}', origin: 'live' }]);
  const staging = path.join(dataDir, 'history', 'earthquake', '2026', '09', '21', 'usgs-earthquakes-0800.staging.ndjson');
  assert.ok(await fileExists(staging));
  await backend.close();
  assert.equal(await fileExists(staging), false, 'close rolls staging into parquet');
  assert.ok(await fileExists(path.join(dataDir, 'history', 'earthquake', '2026', '09', '21', 'usgs-earthquakes-0800.parquet')));
  // Simulate a crash with unrolled staging rows, then reopen.
  await fs.appendFile(staging, JSON.stringify({ observationId: 'usgs-earthquakes:q2:2026-09-21T08:30:00.000Z', objectId: 'earthquake:usgs:q2', providerId: 'usgs-earthquakes', objectType: 'earthquake', observedAt: '2026-09-21T08:30:00.000Z', receivedAt: '2026-09-21T08:30:00.000Z', lat: 36, lon: -119, payloadJson: '{"magnitude":5}', origin: 'live' }) + '\n');
  const reopened = new DuckDbParquetBackend({ dataDir, loadModule: async () => duckdb! });
  await reopened.open();
  assert.equal(await fileExists(staging), false, 'startup recovery rolls leftover staging');
  const rows = (await reopened.readPartition(key)).rows;
  assert.deepEqual(rows.map((r) => r.objectId).sort(), ['earthquake:usgs:q1', 'earthquake:usgs:q2']);
  await reopened.close();
});
