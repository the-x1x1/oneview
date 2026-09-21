import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS, MIGRATIONS, MigrationRunner, SettingsStore, SettingsValidationError, StartupValidator,
  applySettingsPatch, dataDirs, ensureDataDirs, isInsideDir, type Migration,
} from './index.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'worldview-config-'));
}

test('settings store: fresh install uses defaults, patch persists atomically and emits change', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'settings.json');
  const { store, report } = await SettingsStore.open({ file, schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.equal(report.status, 'defaults-fresh');
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);

  const changes: string[] = [];
  store.onChange((s) => changes.push(s.renderMode));
  const next = await store.patch({ renderMode: '2D', providers: { 'usgs-earthquakes': { enabled: false } } });
  assert.equal(next.renderMode, '2D');
  assert.deepEqual(changes, ['2D']);

  const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { schemaVersion: number; settings: { renderMode: string; providers: Record<string, { enabled: boolean }> } };
  assert.equal(onDisk.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(onDisk.settings.renderMode, '2D');
  assert.equal(onDisk.settings.providers['usgs-earthquakes']?.enabled, false);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'atomic write leaves no temp files');

  // Returned objects are copies: mutating them does not change the store.
  const copy = store.get();
  copy.renderMode = '3D';
  assert.equal(store.get().renderMode, '2D');

  // providers merges per id; other top-level keys replace.
  const merged = await store.patch({ providers: { celestrak: { enabled: true } } });
  assert.deepEqual(merged.providers, { 'usgs-earthquakes': { enabled: false }, celestrak: { enabled: true } });
});

test('settings store: invalid patches are rejected without writing', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'settings.json');
  const { store } = await SettingsStore.open({ file, schemaVersion: CURRENT_SCHEMA_VERSION });
  await assert.rejects(store.patch({ textScale: 9 }), SettingsValidationError);
  await assert.rejects(store.patch({ privacy: { telemetry: true as unknown as false } }), SettingsValidationError);
  await assert.rejects(store.patch({ unknownKey: 1 } as unknown as Partial<typeof DEFAULT_SETTINGS>), SettingsValidationError);
  await assert.rejects(store.patch({ providers: { 'Bad Id!': { enabled: true } } }), SettingsValidationError);
  assert.equal(store.get().textScale, 1);
  await assert.rejects(fs.access(file), 'nothing written for a fresh store with only rejected patches');
});

test('settings store: corrupt file is preserved as settings.corrupt-<ts>.json and defaults are used', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, '{ this is not json');
  const now = () => Date.parse('2026-09-21T12:00:00.000Z');
  const { store, report } = await SettingsStore.open({ file, schemaVersion: CURRENT_SCHEMA_VERSION, now });
  assert.equal(report.status, 'defaults-after-corrupt');
  assert.ok(report.corruptFile?.endsWith('settings.corrupt-2026-09-21T12-00-00-000Z.json'));
  assert.equal(await fs.readFile(report.corruptFile!, 'utf8'), '{ this is not json', 'original bytes preserved');
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  const rewritten = JSON.parse(await fs.readFile(file, 'utf8')) as { schemaVersion: number };
  assert.equal(rewritten.schemaVersion, CURRENT_SCHEMA_VERSION);

  // Schema-invalid (but syntactically valid) JSON is treated the same way.
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, settings: { ...DEFAULT_SETTINGS, textScale: 'huge' } }));
  const second = await SettingsStore.open({ file, schemaVersion: CURRENT_SCHEMA_VERSION, now: () => now() + 1000 });
  assert.equal(second.report.status, 'defaults-after-corrupt');
  assert.ok(second.report.issues?.some((i) => i.path === 'settings.textScale'));
});

test('applySettingsPatch never assigns undefined and replaces nested objects wholesale', () => {
  const next = applySettingsPatch(DEFAULT_SETTINGS, { updater: { automatic: true, prerelease: true }, renderMode: undefined as unknown as '2D' });
  assert.deepEqual(next.updater, { automatic: true, prerelease: true });
  assert.equal(next.renderMode, 'AUTO');
});

test('migrations: fresh directory runs all migrations in order and records schemaVersion', async () => {
  const dir = await tmpDir();
  const dirs = dataDirs(dir);
  const runner = new MigrationRunner({ migrations: MIGRATIONS, dirs });
  const report = await runner.run();
  assert.equal(report.ok, true);
  assert.equal(report.from, 0);
  assert.equal(report.to, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(report.applied.map((m) => m.version), MIGRATIONS.map((m) => m.version));
  assert.equal(report.backupFile, undefined, 'nothing to back up on a fresh install');
  const doc = JSON.parse(await fs.readFile(dirs.settingsFile, 'utf8')) as { schemaVersion: number; settings: Record<string, unknown> };
  assert.equal(doc.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(doc.settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  for (const sub of ['history', 'worldpacks', 'cache', 'logs']) assert.ok((await fs.stat(path.join(dir, sub))).isDirectory(), `${sub}/ created`);
  for (const f of ['collections.json', 'watchzones.json', 'lenses.json']) assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')), { version: 1, items: [] });

  // Second run is a no-op.
  const again = await runner.run();
  assert.deepEqual(again.applied, []);
  assert.equal(again.from, CURRENT_SCHEMA_VERSION);
});

test('migrations: upgrade from a legacy document backs up, keeps user values and fills defaults', async () => {
  const dir = await tmpDir();
  const dirs = dataDirs(dir);
  await fs.writeFile(dirs.settingsFile, JSON.stringify({ settings: { renderMode: '2D', activeLensId: 'aviation' } }));
  const report = await new MigrationRunner({ migrations: MIGRATIONS, dirs }).run();
  assert.equal(report.ok, true);
  assert.equal(report.from, 0);
  assert.equal(report.backupFile, `${dirs.settingsFile}.bak-0`);
  assert.equal(await fs.readFile(report.backupFile!, 'utf8'), JSON.stringify({ settings: { renderMode: '2D', activeLensId: 'aviation' } }));
  const { store, report: load } = await SettingsStore.open({ file: dirs.settingsFile, schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.equal(load.status, 'loaded');
  assert.equal(store.get().renderMode, '2D');
  assert.equal(store.get().activeLensId, 'aviation');
  assert.equal(store.get().textScale, 1);
});

test('migrations: a failing migration restores the backup and reports the failure', async () => {
  const dir = await tmpDir();
  const dirs = dataDirs(dir);
  const original = JSON.stringify({ schemaVersion: 1, settings: { ...DEFAULT_SETTINGS, renderMode: '3D' } });
  await fs.writeFile(dirs.settingsFile, original);
  const good: Migration = { version: 2, name: 'good', up: async (ctx) => { ctx.document.marker = 'v2'; } };
  const bad: Migration = { version: 3, name: 'explodes', up: async () => { throw new Error('disk full'); } };
  const report = await new MigrationRunner({ migrations: [MIGRATIONS[0]!, good, bad], dirs }).run();
  assert.equal(report.ok, false);
  assert.deepEqual(report.failed, { version: 3, name: 'explodes', error: 'disk full' });
  assert.equal(report.restored, true);
  assert.deepEqual(report.applied.map((m) => m.version), [2], 'v2 applied before v3 failed');
  assert.equal(await fs.readFile(dirs.settingsFile, 'utf8'), original, 'settings restored byte-for-byte from the backup');
  assert.equal(await fs.readFile(`${dirs.settingsFile}.bak-1`, 'utf8'), original);
});

test('migrations: newer document than the build is left untouched; duplicate versions are rejected', async () => {
  const dir = await tmpDir();
  const dirs = dataDirs(dir);
  await fs.writeFile(dirs.settingsFile, JSON.stringify({ schemaVersion: 99, settings: DEFAULT_SETTINGS }));
  const report = await new MigrationRunner({ migrations: MIGRATIONS, dirs }).run();
  assert.equal(report.newerThanBuild, true);
  assert.equal(report.ok, true);
  assert.throws(() => new MigrationRunner({ migrations: [MIGRATIONS[0]!, { ...MIGRATIONS[0]! }], dirs }), /duplicate migration version 1/);
});

test('startup validator: corrupt settings and user documents become findings, not crashes', async () => {
  const dir = await tmpDir();
  const dirs = dataDirs(dir);
  await ensureDataDirs(dirs);
  await fs.writeFile(dirs.settingsFile, 'garbage');
  await fs.writeFile(dirs.collectionsFile, '[1,2');
  await fs.mkdir(path.join(dirs.worldpacksDir, 'broken-pack'));
  const custom = { name: 'db', area: 'database' as const, run: async () => [{ area: 'database' as const, severity: 'info' as const, message: 'db ok' }] };
  const result = await new StartupValidator({ dirs, checks: [custom], now: () => Date.parse('2026-09-21T00:00:00Z') }).run();
  assert.equal(result.usable, true);
  assert.equal(result.settingsReport.status, 'defaults-after-corrupt');
  const areas = result.findings.map((f) => `${f.area}:${f.severity}`);
  assert.ok(areas.includes('migrations:warn'), 'unreadable settings skip migrations');
  assert.ok(areas.includes('settings:warn'));
  assert.ok(areas.includes('user-documents:warn'));
  assert.ok(areas.includes('worldpacks:warn'));
  assert.ok(areas.includes('database:info'));
  for (const f of result.findings) if (f.file) assert.ok(!path.isAbsolute(f.file), 'findings carry basenames only');
  const preserved = (await fs.readdir(dir)).filter((f) => f.startsWith('collections.corrupt-'));
  assert.equal(preserved.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(dirs.collectionsFile, 'utf8')), { version: 1, items: [] });
});

test('startup validator: fresh directory is usable and migrated', async () => {
  const dir = await tmpDir();
  const result = await new StartupValidator({ dirs: dataDirs(path.join(dir, 'nested', 'userData')) }).run();
  assert.equal(result.usable, true);
  assert.equal(result.migration.ok, true);
  assert.equal(result.settingsReport.status, 'loaded');
  assert.ok(result.findings.every((f) => f.severity === 'info'), JSON.stringify(result.findings));
});

test('data dirs: isInsideDir rejects traversal and absolute escapes', () => {
  const root = path.join(os.tmpdir(), 'wv-root');
  assert.equal(isInsideDir(root, 'worldpacks/pack-a/manifest.json'), true);
  assert.equal(isInsideDir(root, '../other'), false);
  assert.equal(isInsideDir(root, 'worldpacks/../../etc/passwd'), false);
  assert.equal(isInsideDir(root, path.join(os.tmpdir(), 'elsewhere')), false);
  assert.equal(isInsideDir(root, '.'), false, 'the root itself is not "inside"');
});
