import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@worldview/provider-sdk';
import {
  HistoryBackendUnavailableError, HistoryStore, NdjsonBackend, TimelineController, createHistoryBackend,
  type DuckDbModule, type HistoryBackend,
} from '../../src/index.js';
import { AIRCRAFT_PROVIDER, OPEN_POLICY, aircraftObs, batch, iso, makeLogger, policies, tempDir, wrapBackend } from '../helpers/fixtures.js';

const { VirtualClock } = testing;
const T = '2026-09-21T08:00:00.000Z';

test('failure: backend throws on append → store logs, counts failures, stays usable and recovers', async () => {
  const dataDir = await tempDir();
  const clock = new VirtualClock(Date.parse(iso(T, 3600)));
  const { hub, sink } = makeLogger();
  const inner = new NdjsonBackend({ dataDir, clock });
  let failing = true;
  let calls = 0;
  const flaky: HistoryBackend = wrapBackend(inner, {
    append: async (key, rows) => {
      calls++;
      if (failing) throw new Error('EIO: disk unplugged');
      return inner.append(key, rows);
    },
  });
  const store = new HistoryStore({ dataDir, backend: flaky, clock, logger: hub.logger('history'), policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY }) });
  await store.open();

  const r1 = store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(T, 0), 50, 8), aircraftObs('abc123', iso(T, 10), 50.1, 8.1)]));
  assert.equal(r1.queued, 2, 'the caller is never told about backend failures synchronously');
  await store.flush();
  let stats = store.getStats();
  assert.equal(stats.failedAppends, 1);
  assert.equal(stats.failedRows, 2);
  assert.equal(stats.writtenRows, 0);
  assert.equal(stats.queuedRows, 0, 'failed rows are not retried forever');
  assert.match(stats.lastError ?? '', /disk unplugged/);
  assert.ok(sink.records.some((r) => r.level === 'error' && r.message.includes('append failed') && JSON.stringify(r.fields).includes('disk unplugged')), 'failure is logged');

  // Reads keep working against whatever the backend has (nothing yet), and the timeline never claims availability.
  assert.deepEqual(await store.availability(['aircraft']), [{ objectType: 'aircraft', ranges: [] }]);
  assert.deepEqual(await store.objectsAt(iso(T, 30), { objectTypes: ['aircraft'], lookbackSeconds: 600 }), []);
  const timeline = new TimelineController({ history: store, clock });
  assert.deepEqual(await timeline.refreshAvailability(), []);
  const diag = await store.diagnostics();
  assert.equal(diag.status, 'degraded');
  assert.match(diag.message ?? '', /append failures: 1/);
  assert.equal(diag.stats.failedAppends, 1);

  // Backend recovers: subsequent writes land and queries see them.
  failing = false;
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(T, 20), 50.2, 8.2)]));
  await store.flush();
  stats = store.getStats();
  assert.equal(stats.writtenRows, 1);
  assert.equal(stats.failedAppends, 1);
  assert.equal(calls, 2);
  const at = await store.objectsAt(iso(T, 30), { objectTypes: ['aircraft'], lookbackSeconds: 600 });
  assert.equal(at.length, 1);
  assert.equal(at[0]!.observedAt, iso(T, 20));
  assert.deepEqual(await timeline.refreshAvailability(), [{ objectType: 'aircraft', ranges: [{ start: iso(T, 20), end: iso(T, 20) }] }]);

  // A backend that also fails reads: queries reject with the backend error, the store itself does not wedge.
  const dead: HistoryBackend = wrapBackend(inner, { objectsAt: async () => { throw new Error('read failed'); }, diagnostics: async () => { throw new Error('diag failed'); } });
  const store2 = new HistoryStore({ dataDir, backend: dead, clock, policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY }) });
  await assert.rejects(store2.objectsAt(iso(T, 30), { lookbackSeconds: 10 }), /read failed/);
  const diag2 = await store2.diagnostics();
  assert.equal(diag2.status, 'error');
  assert.match(diag2.message ?? '', /diag failed/);
  await store.close();
});

test('failure: retention sweep survives a partition that cannot be rewritten or deleted', async () => {
  const dataDir = await tempDir();
  const clock = new VirtualClock(Date.parse(iso(T, 3600)));
  const inner = new NdjsonBackend({ dataDir, clock });
  const { hub, sink } = makeLogger();
  const brittle: HistoryBackend = wrapBackend(inner, {
    rewritePartition: async () => { throw new Error('rewrite refused'); },
    deletePartition: async () => { throw new Error('delete refused'); },
  });
  const store = new HistoryStore({ dataDir, backend: brittle, clock, logger: hub.logger('history'), policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY }) });
  await store.open();
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(T, 0), 50, 8), aircraftObs('abc123', iso(T, 1), 50, 8), aircraftObs('abc123', iso(T, 2), 50, 8), aircraftObs('abc123', iso(T, 3), 50, 8)]));
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('old999', iso(T, -40 * 86_400), 1, 1)]));
  await store.flush();
  const report = await store.sweepRetention(Date.parse(iso(T, 40 * 60)));
  assert.equal(report.deleted.length, 0);
  assert.equal(report.rewritten.length, 0);
  assert.equal(report.errors.length, 2, 'one error per partition, sweep continued');
  assert.ok(report.errors.some((e) => /rewrite refused/.test(e.error)) && report.errors.some((e) => /delete refused/.test(e.error)));
  assert.equal((await inner.listPartitions()).length, 2, 'nothing lost');
  assert.ok(sink.records.filter((r) => r.level === 'error' && r.message.includes('retention step failed')).length === 2);
  await store.close();
});

test('failure: DuckDB backend absent → falls back to NDJSON with the reason recorded in diagnostics', async () => {
  const dataDir = await tempDir();
  const { hub, sink } = makeLogger();
  const created = await createHistoryBackend({
    dataDir, preferred: 'duckdb-parquet', logger: hub.logger('history'),
    duckdb: { loadModule: async () => { throw new HistoryBackendUnavailableError('duckdb-parquet', 'cannot load @duckdb/node-api: Cannot find package'); } },
  });
  assert.equal(created.backend.kind, 'ndjson');
  assert.equal(created.requestedBackend, 'duckdb-parquet');
  assert.match(created.fallbackReason ?? '', /cannot load @duckdb\/node-api/);
  assert.ok(sink.records.some((r) => r.level === 'warn' && r.message.includes('falling back to NDJSON')));
  const store = new HistoryStore({ dataDir, backend: created.backend, requestedBackend: created.requestedBackend, ...(created.fallbackReason ? { fallbackReason: created.fallbackReason } : {}), policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY }) });
  store.writeBatch(batch(AIRCRAFT_PROVIDER, [aircraftObs('abc123', iso(T, 0), 50, 8)]));
  await store.flush();
  assert.equal(store.getStats().writtenRows, 1, 'the fallback backend is fully usable');
  const diag = await store.diagnostics();
  assert.equal(diag.kind, 'ndjson');
  assert.equal(diag.requestedBackend, 'duckdb-parquet');
  assert.equal(diag.status, 'degraded');
  assert.match(diag.fallbackReason ?? '', /cannot load/);
  assert.match(diag.message ?? '', /fallback from duckdb-parquet/);
  assert.equal(diag.partitions, 1);
  await store.close();

  // A fault that is NOT "module unavailable" (here: the data directory is a file) is a real error and is not masked by a fallback.
  const notADir = path.join(await tempDir(), 'not-a-dir');
  await fs.writeFile(notADir, 'x');
  const fakeModule = {
    DuckDBInstance: { create: async () => ({ connect: async () => ({ run: async () => ({}), runAndReadAll: async () => ({ getRowObjects: () => [] }), closeSync() {} }), closeSync() {} }) },
  } as unknown as DuckDbModule;
  await assert.rejects(
    createHistoryBackend({ dataDir: notADir, preferred: 'duckdb-parquet', duckdb: { loadModule: async () => fakeModule } }),
    (err: unknown) => err instanceof Error && !(err instanceof HistoryBackendUnavailableError),
  );
});

test('failure: real environment — DuckDB either loads or the fallback is recorded honestly', async () => {
  const dataDir = await tempDir();
  const created = await createHistoryBackend({ dataDir, preferred: 'duckdb-parquet' });
  let installed = true;
  try { await import('@duckdb/node-api'); } catch { installed = false; }
  if (installed) {
    assert.equal(created.backend.kind, 'duckdb-parquet');
    assert.equal(created.fallbackReason, undefined);
  } else {
    assert.equal(created.backend.kind, 'ndjson');
    assert.match(created.fallbackReason ?? '', /cannot load @duckdb\/node-api/);
  }
  await created.backend.close();
});
