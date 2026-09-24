import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderError } from '@worldview/provider-sdk';
import { createLocalAccess } from './provider-storage.js';
import { childEnvironment, createOgr2ogrAccess, isStrictlyInside, type Ogr2ogrHostOptions } from './granted-folder.js';

/**
 * The granted folder (ADR-003 amendments 2026-09-23): reads and stats stay inside the folder
 * the function answers at the time of the call, so a folder the user renames in settings
 * applies to the next read without a restart, and clearing it refuses the next read. Paths
 * are compared as real paths, so a link or junction that leads out is refused.
 */
function tempDir(t: { after(fn: () => void): void }, prefix = 'wv-grant-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir: string, rel: string, content: string | Uint8Array): string {
  const abs = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

async function rejects(p: Promise<unknown>, code: string, includes?: string | RegExp): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (includes)
      assert.ok(
        typeof includes === 'string' ? err.message.includes(includes) : includes.test(err.message),
        err.message,
      );
    return err;
  }
  assert.fail(`expected ${code}, but it resolved`);
}

test('granted folder: reads and stats inside the current grant; escapes, directories, a cleared grant refused', async (t) => {
  const root = tempDir(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  mkdirSync(path.join(a, 'sub'), { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(path.join(a, 'sub', 'points.geojson'), '{"type":"FeatureCollection","features":[]}');
  writeFileSync(path.join(b, 'other.csv'), 'id,lat,lon\n');
  utimesSync(path.join(a, 'sub', 'points.geojson'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  let grant: string | undefined = a;
  const access = createLocalAccess({ allowedHosts: [], grantDir: () => grant });
  assert.equal(access.ogr2ogr, undefined, 'no converter unless asked for');

  const bytes = await access.readGrantedFile('sub/points.geojson');
  assert.equal(Buffer.from(bytes).toString(), '{"type":"FeatureCollection","features":[]}');
  const stat = await access.statGrantedFile!('sub/points.geojson');
  assert.equal(stat.size, bytes.byteLength);
  assert.equal(Math.round(stat.mtimeMs), 1_700_000_000_000);

  await rejects(access.readGrantedFile('../b/other.csv'), 'HOST_NOT_ALLOWED', 'climbs out');
  await rejects(access.readGrantedFile(path.join(b, 'other.csv')), 'HOST_NOT_ALLOWED');
  await rejects(access.readGrantedFile('\\\\server\\share\\secret.gpx'), 'HOST_NOT_ALLOWED', 'UNC');
  await rejects(access.statGrantedFile!('sub'), 'UNSUPPORTED', 'is a folder, not a file');
  await rejects(access.readGrantedFile('sub/missing.geojson'), 'UNSUPPORTED', 'does not exist');
  await rejects(access.readGrantedFile('sub/points.geojson', { maxBytes: 4 }), 'TOO_LARGE');
  await rejects(
    createLocalAccess({ allowedHosts: [], grantDir: path.join(root, 'nope') }).statGrantedFile!('a.gpx'),
    'UNSUPPORTED',
    'does not exist',
  );

  grant = b;
  assert.equal(
    Buffer.from(await access.readGrantedFile('other.csv')).toString(),
    'id,lat,lon\n',
    'the new folder applies at once',
  );
  await rejects(access.readGrantedFile('sub/points.geojson'), 'UNSUPPORTED');

  grant = '';
  await rejects(access.readGrantedFile('other.csv'), 'UNSUPPORTED', 'no folder is granted');
  grant = undefined;
  await rejects(access.readGrantedFile('other.csv'), 'UNSUPPORTED', 'no folder is granted');
});

test('granted folder: a directory link out of the folder is refused; one that stays inside is read', async (t) => {
  const dir = tempDir(t);
  const granted = path.join(dir, 'granted');
  const outside = path.join(dir, 'outside');
  put(granted, 'gps/walk.gpx', '<gpx><wpt lat="21.26" lon="-157.81"><name>walk</name></wpt></gpx>');
  put(outside, 'secret.gpx', '<gpx><wpt lat="1" lon="2"><name>secret</name></wpt></gpx>');
  const access = createLocalAccess({ allowedHosts: [], grantDir: granted });
  const bytes = await access.readGrantedFile('gps/walk.gpx');

  // A directory link (a junction on Windows, which needs no privilege) that leads out of the folder.
  symlinkSync(outside, path.join(granted, 'escape'), 'junction');
  await rejects(access.readGrantedFile('escape/secret.gpx'), 'HOST_NOT_ALLOWED', 'leads outside the granted folder');
  await rejects(access.statGrantedFile!('escape/secret.gpx'), 'HOST_NOT_ALLOWED', 'leads outside the granted folder');
  // A link that stays inside is fine.
  symlinkSync(path.join(granted, 'gps'), path.join(granted, 'also-gps'), 'junction');
  assert.equal((await access.readGrantedFile('also-gps/walk.gpx')).length, bytes.length);
});

test('granted folder: a file link out of the folder is refused (needs symlink rights on Windows)', async (t) => {
  const dir = tempDir(t);
  const granted = path.join(dir, 'granted');
  put(dir, 'outside/secret.gpx', '<gpx/>');
  mkdirSync(granted);
  try {
    symlinkSync(path.join(dir, 'outside', 'secret.gpx'), path.join(granted, 'innocent.gpx'), 'file');
  } catch (err) {
    t.skip(
      `this account cannot create file symlinks (${(err as NodeJS.ErrnoException).code}); the junction test covers links`,
    );
    return;
  }
  await rejects(
    createLocalAccess({ allowedHosts: [], grantDir: granted }).readGrantedFile('innocent.gpx'),
    'HOST_NOT_ALLOWED',
  );
});

test(
  'granted folder: a FIFO is not read (it would block the poll forever)',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = tempDir(t);
    execFileSync('mkfifo', [path.join(dir, 'pipe.csv')]);
    await rejects(
      createLocalAccess({ allowedHosts: [], grantDir: dir }).readGrantedFile('pipe.csv'),
      'UNSUPPORTED',
      'not a regular file',
    );
  },
);

test('containment compares real paths, case-insensitively only on Windows', () => {
  assert.equal(isStrictlyInside('/data/granted', '/data/granted/a.gpx', 'linux'), true);
  assert.equal(isStrictlyInside('/data/granted', '/data/granted-other/a.gpx', 'linux'), false);
  assert.equal(isStrictlyInside('/data/granted', '/data/granted', 'linux'), false);
  assert.equal(isStrictlyInside('/data/Granted', '/data/granted/a.gpx', 'linux'), false);
  assert.equal(isStrictlyInside('C:\\Data\\Granted', 'c:\\data\\granted\\a.gpx', 'win32'), true);
  assert.equal(isStrictlyInside('C:\\Data\\Granted', 'D:\\Data\\Granted\\a.gpx', 'win32'), false);
  assert.equal(isStrictlyInside('\\\\nas\\gis', '\\\\nas\\gis\\roads.shp', 'win32'), true);
  assert.equal(isStrictlyInside('\\\\nas\\gis', '\\\\other\\gis\\roads.shp', 'win32'), false);
});

// ── the ogr2ogr host with a stand-in program ─────────────────────────────────

const STAND_IN = `// Stands in for ogr2ogr in tests: it records its arguments and environment, then behaves
// as standin.json in its own folder says. It is not GDAL and converts nothing.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(readFileSync(path.join(here, 'standin.json'), 'utf8'));
const args = process.argv.slice(2);
appendFileSync(path.join(here, 'calls.ndjson'), JSON.stringify({ args, env: Object.keys(process.env) }) + '\\n');
if (args[0] === '--version') {
  console.log('GDAL 3.9.2-standin, released 2026/01/01');
  process.exit(0);
}
if (conf.mode === 'hang') setInterval(() => {}, 1000);
else if (conf.mode === 'fail') {
  console.error('ERROR 1: first line');
  console.error("ERROR 4: Unable to open datasource with the following drivers.");
  process.exit(1);
} else if (conf.mode === 'silent') process.exit(0);
else writeFileSync(args[args.indexOf('RFC7946=YES') + 1], readFileSync(conf.output));
`;

/** What a child process needs to start on this machine (Windows needs SystemRoot), and nothing of WORLDVIEW's. */
const SYSTEM_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR)$/i.test(k)),
);

const PARCELS_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 1,
      properties: { PARCEL_ID: '1-2-003-004', zoning: 'R-5' },
      geometry: { type: 'Point', coordinates: [-157.81, 21.29] },
    },
    {
      type: 'Feature',
      id: 2,
      properties: { PARCEL_ID: '1-2-003-005', zoning: 'R-5' },
      geometry: { type: 'Point', coordinates: [-157.82, 21.3] },
    },
  ],
});

function standIn(t: { after(fn: () => void): void }, mode: string, output?: string) {
  const dir = tempDir(t, 'wv-standin-');
  writeFileSync(path.join(dir, 'ogr2ogr.mjs'), STAND_IN);
  writeFileSync(path.join(dir, 'standin.json'), JSON.stringify({ mode, output }));
  const calls = () =>
    existsSync(path.join(dir, 'calls.ndjson'))
      ? readFileSync(path.join(dir, 'calls.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { args: string[]; env: string[] })
      : [];
  return { program: { command: process.execPath, args: [path.join(dir, 'ogr2ogr.mjs')] }, calls };
}

function shapefileFolder(t: { after(fn: () => void): void }) {
  const folder = tempDir(t);
  for (const ext of ['shp', 'shx', 'dbf', 'prj']) put(folder, `gis/parcels/parcels.${ext}`, `stand-in ${ext} bytes`);
  const output = put(tempDir(t), 'out.geojson', PARCELS_GEOJSON);
  return { folder, output };
}

test('ogr2ogr host: fixed arguments, no shell, no WORLDVIEW secrets in its environment, the temporary folder removed', async (t) => {
  const { folder, output } = shapefileFolder(t);
  const s = standIn(t, 'ok', output);
  const tmp = tempDir(t, 'wv-ogr-tmp-');
  const opts: Ogr2ogrHostOptions = {
    folder,
    program: s.program,
    env: {
      ...SYSTEM_ENV,
      GDAL_DATA: '/opt/gdal',
      ONEVIEW_SECRET_FIRMS: 'do-not-leak',
      WORLDVIEW_TOKEN: 'nor-this',
      AWS_SECRET_ACCESS_KEY: 'x',
    },
    tmpDir: tmp,
  };
  const host = createOgr2ogrAccess(opts);
  assert.deepEqual(await host.detect(), { found: true, version: '3.9.2-standin' });
  const bytes = await host.toGeoJson({ input: 'gis/parcels/parcels.shp', layer: 'parcels', timeoutMs: 20_000 });
  assert.equal(new TextDecoder().decode(bytes), PARCELS_GEOJSON);
  const call = s.calls()[1]!;
  assert.deepEqual(call.args.slice(0, 6), ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-lco', 'RFC7946=YES']);
  assert.ok(call.args[6]!.startsWith(tmp), 'the output goes to a fresh temporary folder');
  assert.equal(call.args[7], path.join(realpathSync.native(folder), 'gis', 'parcels', 'parcels.shp'));
  assert.equal(call.args[8], 'parcels');
  assert.equal(call.args.length, 9);
  assert.ok(call.env.includes('GDAL_DATA'));
  assert.ok(!call.env.includes('ONEVIEW_SECRET_FIRMS'), 'a secret reached ogr2ogr');
  assert.ok(!call.env.includes('WORLDVIEW_TOKEN'));
  assert.ok(!call.env.includes('AWS_SECRET_ACCESS_KEY'));
  assert.deepEqual(readdirSync(tmp), [], 'the temporary folder was removed');
  assert.deepEqual(childEnvironment({ Path: 'x', ONEVIEW_TOKEN: 'y', PROJ_DATA: 'z' }), { Path: 'x', PROJ_DATA: 'z' });
});

test('ogr2ogr host: a failure, a hang, an empty run, an oversized result and refused inputs', async (t) => {
  const { folder, output } = shapefileFolder(t);
  const run = (mode: string, extra: Partial<Ogr2ogrHostOptions> = {}) =>
    createOgr2ogrAccess({ folder, program: standIn(t, mode, output).program, env: SYSTEM_ENV, ...extra });
  await rejects(run('fail').toGeoJson({ input: 'gis/parcels/parcels.shp' }), 'MALFORMED', 'Unable to open datasource');
  await rejects(run('hang').toGeoJson({ input: 'gis/parcels/parcels.shp', timeoutMs: 400 }), 'TIMEOUT');
  await rejects(run('silent').toGeoJson({ input: 'gis/parcels/parcels.shp' }), 'MALFORMED', 'wrote nothing');
  await rejects(run('ok').toGeoJson({ input: 'gis/parcels/parcels.shp', maxOutputBytes: 100 }), 'TOO_LARGE');
  const abort = new AbortController();
  const pending = run('hang').toGeoJson({ input: 'gis/parcels/parcels.shp', signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await rejects(pending, 'CANCELLED');
  await rejects(run('ok').toGeoJson({ input: 'gis/mosaic.vrt' }), 'UNSUPPORTED', 'not a format the host converts');
  await rejects(run('ok').toGeoJson({ input: '../elsewhere.shp' }), 'HOST_NOT_ALLOWED');
  await rejects(run('ok').toGeoJson({ input: 'gis/parcels/parcels.shp', layer: '-sql' }), 'HOST_NOT_ALLOWED');
  assert.deepEqual(await run('ok', { program: null }).detect(), { found: false, reason: 'ogr2ogr is not on PATH' });
  await rejects(run('ok', { program: null }).toGeoJson({ input: 'gis/parcels/parcels.shp' }), 'UNSUPPORTED');
});

test('ogr2ogr host: a shapefile is its parts — an edited .dbf is a change, a .dbf linked out of the folder is refused', async (t) => {
  const { folder } = shapefileFolder(t);
  const host = createOgr2ogrAccess({ folder, program: null });
  const before = await host.datasetStat('gis/parcels/parcels.shp');
  assert.equal(
    before.size,
    ['shp', 'shx', 'dbf', 'prj'].reduce((n, e) => n + `stand-in ${e} bytes`.length, 0),
  );
  const dbf = path.join(folder, 'gis', 'parcels', 'parcels.dbf');
  writeFileSync(dbf, 'stand-in dbf bytes, edited');
  utimesSync(dbf, new Date(before.mtimeMs + 60_000), new Date(before.mtimeMs + 60_000));
  const after = await host.datasetStat('gis/parcels/parcels.shp');
  assert.ok(after.size > before.size && after.mtimeMs > before.mtimeMs);

  rmSync(dbf);
  const outside = put(tempDir(t), 'stolen.dbf', 'somebody else');
  try {
    symlinkSync(outside, dbf, 'file');
  } catch (err) {
    t.skip(`this account cannot create file symlinks (${(err as NodeJS.ErrnoException).code})`);
    return;
  }
  await rejects(host.datasetStat('gis/parcels/parcels.shp'), 'HOST_NOT_ALLOWED', 'parcels.dbf leads outside');
});

test('local access offers ogr2ogr only when asked, on the current grant', async (t) => {
  const { folder, output } = shapefileFolder(t);
  const s = standIn(t, 'ok', output);
  let grant: string | undefined = folder;
  const access = createLocalAccess({
    allowedHosts: [],
    grantDir: () => grant,
    ogr2ogr: { program: s.program, env: SYSTEM_ENV },
  });
  assert.ok(access.ogr2ogr);
  const bytes = await access.ogr2ogr.toGeoJson({ input: 'gis/parcels/parcels.shp' });
  assert.equal(new TextDecoder().decode(bytes), PARCELS_GEOJSON);
  grant = undefined;
  await rejects(access.ogr2ogr.datasetStat('gis/parcels/parcels.shp'), 'UNSUPPORTED', 'no folder is granted');
});
