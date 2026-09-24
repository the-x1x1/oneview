import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, testing, type ProviderLocalAccess, type WorldProvider } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { loadSidecar } from '@worldview/tool-connector-validator';
import { defaultConnectorRegistry } from '../../registry.js';
import { runConnectorSuite, formatSuite } from '../../testing/suite.js';
import {
  GdalImportProvider,
  LocalFileProvider,
  checkRelativePath,
  decodeText,
  mergeLayers,
  parseXml,
  readGpx,
  readKml,
  readTopoJson,
  validateGdalImport,
  validateLocalFile,
  type FileSource,
  type Ogr2ogrAccess,
} from './index.js';
import { FileSuiteRegistry } from './testing/suite-shim.js';
import {
  childEnvironment,
  createGrantedFolderAccess,
  createOgr2ogrAccess,
  isStrictlyInside,
  type Ogr2ogrHostOptions,
} from './testing/host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const examplesDir = path.join(root, 'connectors', 'examples', 'files', 'awaiting-amendments');
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', 'files', name));
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(examplesDir, name), 'utf8')) as Record<string, unknown>;
const NOW = Date.parse('2026-09-23T20:00:00.000Z');

function tempDir(t: { after(fn: () => void): void }, prefix = 'wv-files-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir: string, rel: string, content: string | Uint8Array): string {
  const abs = path.join(dir, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** A provider initialised against a context whose local access is `local`. */
async function started(provider: WorldProvider, local: ProviderLocalAccess, clock = new testing.VirtualClock(NOW)) {
  const base = testing.createFixtureContext({ providerId: provider.manifest.id, clock });
  const context = { ...base, local };
  await provider.initialize(context);
  await provider.start();
  return { context, clock, query: () => provider.query!({ signal: new AbortController().signal, background: true }) };
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

/** A definition document from an example, with the `file` block changed. */
function withFile(name: string, file: Record<string, unknown>): Record<string, unknown> {
  const doc = example(name);
  return { ...doc, file: { ...(doc['file'] as object), ...file } };
}

function definitionOf(doc: unknown) {
  const v = new FileSuiteRegistry().validate(doc);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  return v.definition;
}

// ── the shared suite, on every example ───────────────────────────────────────

const examples = readdirSync(examplesDir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'))
  .sort();

test('every file example has a sidecar, and there is one per format plus GDAL', () => {
  assert.deepEqual(examples, [
    'csv-rain-gauges.json',
    'gdal-parcels.json',
    'geojson-community-gardens.json',
    'gpx-diamond-head-walk.json',
    'kml-reef-survey.json',
    'topojson-districts.json',
  ]);
  for (const f of examples) assert.ok(existsSync(path.join(examplesDir, f.replace(/\.json$/, '.test.json'))), f);
});

for (const file of examples) {
  test(`shared connector suite: ${file} (through the A1/A4 shim)`, async (t) => {
    const fixtures = loadSidecar(path.join(examplesDir, file.replace(/\.json$/, '.test.json')), root);
    const r = await runConnectorSuite(example(file), fixtures, new FileSuiteRegistry());
    for (const line of formatSuite(r).split('\n')) t.diagnostic(line);
    assert.ok(r.passed, '\n' + formatSuite(r));
    assert.equal(r.checks.length, 14);
  });
}

test('the suite run through the shim fails when it should: a wrong count, an accepted malformed body, a wrong attribution, an escaping path', async () => {
  const name = 'gpx-diamond-head-walk';
  const fixtures = loadSidecar(path.join(examplesDir, `${name}.test.json`), root);
  const doc = example(`${name}.json`);
  const failed = async (d: unknown, f: typeof fixtures) =>
    (await runConnectorSuite(d, f, new FileSuiteRegistry())).checks.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(await failed(doc, { ...fixtures, expectObservations: 5 }), ['Successful parse']);
  assert.deepEqual(await failed(doc, { ...fixtures, malformed: ['<gpx><wpt lat="1" lon="2"/></gpx>'] }), [
    'Malformed response',
  ]);
  assert.deepEqual(await failed({ ...doc, attribution: { text: 'someone else' } }, fixtures), ['Successful parse']);
  assert.deepEqual(await failed({ ...doc, file: { path: '../x.gpx' } }, fixtures), ['Config validation']);
});

test('the frozen registry drops the file block today (amendment A1): when this fails, A1 has landed — delete the shim', () => {
  const r = defaultConnectorRegistry.validate(example('gpx-diamond-head-walk.json'));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /needs a "file" block/);
  assert.deepEqual(
    defaultConnectorRegistry.ids().filter((id) => id === 'local-file' || id === 'gdal-import'),
    ['gdal-import', 'local-file'],
  );
});

// ── path policy ──────────────────────────────────────────────────────────────

test('path policy: relative paths inside the folder are accepted and normalised', () => {
  for (const [input, want] of [
    ['tracks/run.gpx', 'tracks/run.gpx'],
    ['./tracks/./run.gpx', 'tracks/run.gpx'],
    ['gis\\parcels\\parcels.shp', 'gis/parcels/parcels.shp'],
    ['Kāneʻohe survey (2026).kml', 'Kāneʻohe survey (2026).kml'],
  ] as const) {
    const v = checkRelativePath(input);
    assert.ok(v.ok, `${input}: ${v.ok ? '' : v.reason}`);
    assert.equal(v.path, want);
  }
});

test('path policy: outside the folder, UNC, device, drive, stream and Windows-aliased names are refused', () => {
  for (const [input, reason] of [
    ['', /empty/],
    ['/etc/passwd', /absolute/],
    ['\\Windows\\win.ini', /absolute/],
    ['C:\\Users\\x\\a.gpx', /drive/],
    ['C:a.gpx', /drive/],
    ['\\\\server\\share\\a.gpx', /UNC or device/],
    ['//server/share/a.gpx', /UNC or device/],
    ['\\\\?\\C:\\a.gpx', /UNC or device/],
    ['\\\\.\\PhysicalDrive0', /UNC or device/],
    ['file:///etc/passwd', /":"/],
    ['a.gpx:hidden', /":"/],
    ['../outside.gpx', /climbs out/],
    ['tracks/../../outside.gpx', /climbs out/],
    ['tracks//run.gpx', /empty segment/],
    ['~/run.gpx', /home folder/],
    ['run.gpx.', /dot or a space/],
    ['run.gpx ', /dot or a space/],
    ['tracks/con.gpx', /device name/],
    ['NUL', /device name/],
    ['com1.txt', /device name/],
    ['run?.gpx', /Windows forbids/],
    ['run\u0000.gpx', /control character/],
    ['.', /folder itself/],
    ['x'.repeat(1025), /longer than/],
  ] as const) {
    const v = checkRelativePath(input);
    assert.equal(v.ok, false, `${JSON.stringify(input)} was accepted`);
    if (!v.ok) assert.match(v.reason, reason, JSON.stringify(input));
  }
});

test('a definition naming a path outside the folder does not validate, and no provider is built for it', () => {
  for (const bad of ['../secret.gpx', '\\\\fileserver\\share\\track.gpx', 'C:\\track.gpx', '/home/x/track.gpx']) {
    const r = new FileSuiteRegistry().validate(withFile('gpx-diamond-head-walk.json', { path: bad }));
    assert.equal(r.ok, false, bad);
    assert.match(r.errors.join('; '), /file\.path/);
    assert.throws(
      () =>
        new LocalFileProvider({ ...definitionOf(example('gpx-diamond-head-walk.json')), file: { path: bad } } as never),
    );
  }
});

// ── the granted folder, on a real file system (A2) ───────────────────────────

test('granted folder: reads inside it; refuses a link out of it, a missing file, a folder and no grant at all', async (t) => {
  const dir = tempDir(t);
  const granted = path.join(dir, 'granted');
  const outside = path.join(dir, 'outside');
  put(granted, 'gps/walk.gpx', fixture('diamond-head-walk.gpx'));
  put(outside, 'secret.gpx', '<gpx><wpt lat="1" lon="2"><name>secret</name></wpt></gpx>');
  mkdirSync(path.join(granted, 'empty-folder'));
  const access = createGrantedFolderAccess({ folder: granted });

  const bytes = await access.readGrantedFile('gps/walk.gpx');
  assert.equal(bytes.length, fixture('diamond-head-walk.gpx').length);
  const st = await access.statGrantedFile('gps/walk.gpx');
  assert.equal(st.size, bytes.length);

  await rejects(access.readGrantedFile('../outside/secret.gpx'), 'HOST_NOT_ALLOWED', 'climbs out');
  await rejects(access.readGrantedFile('\\\\server\\share\\secret.gpx'), 'HOST_NOT_ALLOWED', 'UNC');
  await rejects(access.readGrantedFile(path.join(outside, 'secret.gpx')), 'HOST_NOT_ALLOWED');
  await rejects(access.readGrantedFile('gps/missing.gpx'), 'UNSUPPORTED', 'does not exist');
  await rejects(access.readGrantedFile('empty-folder'), 'UNSUPPORTED', 'is a folder');
  await rejects(
    createGrantedFolderAccess({ folder: undefined }).readGrantedFile('gps/walk.gpx'),
    'UNSUPPORTED',
    'no folder is granted',
  );
  await rejects(
    createGrantedFolderAccess({ folder: '' }).statGrantedFile('gps/walk.gpx'),
    'UNSUPPORTED',
    'no folder is granted',
  );
  await rejects(
    createGrantedFolderAccess({ folder: path.join(dir, 'nope') }).statGrantedFile('a.gpx'),
    'UNSUPPORTED',
    'does not exist',
  );
  await rejects(
    createGrantedFolderAccess({ folder: granted, maxBytes: 1024 }).readGrantedFile('gps/walk.gpx'),
    'TOO_LARGE',
  );

  // A directory link (a junction on Windows, which needs no privilege) that leads out of the folder.
  symlinkSync(outside, path.join(granted, 'escape'), 'junction');
  await rejects(access.readGrantedFile('escape/secret.gpx'), 'HOST_NOT_ALLOWED', 'leads outside the granted folder');
  await rejects(access.statGrantedFile('escape/secret.gpx'), 'HOST_NOT_ALLOWED', 'leads outside the granted folder');
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
  await rejects(createGrantedFolderAccess({ folder: granted }).readGrantedFile('innocent.gpx'), 'HOST_NOT_ALLOWED');
});

test(
  'granted folder: a FIFO is not read (it would block the poll forever)',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = tempDir(t);
    execFileSync('mkfifo', [path.join(dir, 'pipe.csv')]);
    await rejects(
      createGrantedFolderAccess({ folder: dir }).readGrantedFile('pipe.csv'),
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

// ── the provider over a real folder: mtime polling, caps, file time ──────────

function countingAccess(folder: string, maxBytes?: number) {
  const access = createGrantedFolderAccess({ folder, ...(maxBytes ? { maxBytes } : {}) });
  const counts = { stat: 0, read: 0 };
  const wrapped = {
    ...access,
    statGrantedFile: (p: string) => {
      counts.stat++;
      return access.statGrantedFile(p);
    },
    readGrantedFile: (p: string, o?: { maxBytes?: number }) => {
      counts.read++;
      return access.readGrantedFile(p, o);
    },
  };
  return { access: wrapped, counts };
}

test('local-file polls the modification time and re-reads only when the file changed, never more often than every 5 s', async (t) => {
  const dir = tempDir(t);
  const file = put(dir, 'gps/diamond-head-walk.gpx', fixture('diamond-head-walk.gpx'));
  const firstMtime = new Date('2026-09-23T18:00:00.000Z');
  utimesSync(file, firstMtime, firstMtime);
  const { access, counts } = countingAccess(dir);
  const provider = new LocalFileProvider(definitionOf(example('gpx-diamond-head-walk.json')));
  const { clock, query } = await started(provider, access);

  const first = await query();
  assert.equal(first.length, 4);
  assert.deepEqual(counts, { stat: 2, read: 1 });
  const waypoint2 = first.find((o) => o.externalId === 'waypoint-2')!;
  assert.equal(waypoint2.observedAt, firstMtime.toISOString(), 'a record without a time is dated by the file');
  assert.deepEqual(waypoint2.quality.flags, ['file-time']);

  clock.advance(1_000);
  assert.equal(await query(), first, 'within 5 s the cached observations are served without looking');
  assert.deepEqual(counts, { stat: 2, read: 1 });

  clock.advance(30_000);
  const unchanged = await query();
  assert.deepEqual(counts, { stat: 3, read: 1 }, 'an unchanged file is looked at, not read');
  assert.deepEqual(
    unchanged.map((o) => o.id),
    first.map((o) => o.id),
    'an unchanged file yields the same observations',
  );
  assert.equal((await provider.health()).status, 'LIVE');

  const text = fixture('diamond-head-walk.gpx')
    .toString('utf8')
    .replace('<rte>', '<wpt lat="21.2650" lon="-157.8080"><name>Added later</name></wpt>\n  <rte>');
  writeFileSync(file, text);
  const secondMtime = new Date('2026-09-23T19:30:00.000Z');
  utimesSync(file, secondMtime, secondMtime);
  clock.advance(30_000);
  const changed = await query();
  assert.deepEqual(counts, { stat: 5, read: 2 });
  assert.equal(changed.length, 5);
  const added = changed.find((o) => o.externalId === 'waypoint-4');
  assert.equal(added?.payload['name'], 'Added later');
  assert.equal(added?.observedAt, secondMtime.toISOString());
  const h = await provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message ?? '', /1 record\(s\) in gps\/diamond-head-walk\.gpx rejected/);

  // Gone: the error is reported, and a refresh a second later does not bring the old objects back.
  rmSync(file);
  clock.advance(30_000);
  await rejects(query(), 'UNSUPPORTED', 'does not exist');
  clock.advance(1_000);
  await rejects(query(), 'UNSUPPORTED', 'does not exist');
  assert.equal((await provider.health()).status, 'DEGRADED');
});

test('local-file refuses a file over its size cap before reading it, and a link out of the folder', async (t) => {
  const dir = tempDir(t);
  put(dir, 'gps/diamond-head-walk.gpx', fixture('diamond-head-walk.gpx'));
  const small = new LocalFileProvider(definitionOf(withFile('gpx-diamond-head-walk.json', { maxBytes: 1024 })));
  const { access, counts } = countingAccess(dir);
  const s = await started(small, access);
  await rejects(s.query(), 'TOO_LARGE', 'the limit is 1024');
  assert.equal(counts.read, 0, 'the size is known from the stat: nothing is read');
  assert.equal((await small.health()).status, 'ERROR');

  const outside = path.join(tempDir(t), 'elsewhere');
  put(outside, 'walk.gpx', fixture('diamond-head-walk.gpx'));
  symlinkSync(outside, path.join(dir, 'linked'), 'junction');
  const linked = new LocalFileProvider(
    definitionOf(withFile('gpx-diamond-head-walk.json', { path: 'linked/walk.gpx' })),
  );
  const l = await started(linked, createGrantedFolderAccess({ folder: dir }));
  await rejects(l.query(), 'HOST_NOT_ALLOWED', 'leads outside the granted folder');
});

test('local-file on a host without the granted-folder amendment reports UNSUPPORTED and reads nothing', async () => {
  const provider = new LocalFileProvider(definitionOf(example('gpx-diamond-head-walk.json')));
  const { query } = await started(
    provider,
    new testing.FixtureLocalAccess({ 'gps/diamond-head-walk.gpx': fixture('diamond-head-walk.gpx') }),
  );
  await rejects(query(), 'UNSUPPORTED', 'cannot grant a folder');
});

test('manifest: filesystem transport, no hosts, the folder setting the host grants, a cadence the rate policy covers', () => {
  const m = new LocalFileProvider(definitionOf(example('csv-rain-gauges.json'))).manifest;
  assert.equal(m.transport, 'filesystem');
  assert.deepEqual(m.allowedHosts, []);
  assert.equal(m.grantedFolderSetting, 'folder');
  assert.equal(m.settings?.[0]?.key, 'folder');
  assert.equal(m.refreshPolicy.intervalMs, 60_000);
  assert.equal(m.refreshPolicy.minIntervalMs, 5_000);
  assert.ok(m.refreshPolicy.maxRequestsPerMinute * m.refreshPolicy.intervalMs >= 60_000);
  assert.equal(m.capabilities.offline, true);
  assert.equal(m.commercialReview, 'manual-review-required');
  assert.equal(m.enabledByDefault, false);
  assert.equal(m.dataPolicy.exportAllowed, false);
});

test('a file that changes while it is read is served but not remembered; unparseable mid-write it is retried', async () => {
  const good = fixture('rain-gauges.csv');
  let stats = 0;
  let body: Uint8Array = good;
  const source: FileSource = {
    stat: async () => ({ size: body.length, mtimeMs: NOW - 60_000 + stats++ }),
    load: async () => body,
  };
  const provider = new LocalFileProvider(definitionOf(example('csv-rain-gauges.json')), { source: () => source });
  const { clock, query } = await started(provider, new testing.FixtureLocalAccess());
  assert.equal((await query()).length, 3);
  clock.advance(10_000);
  assert.equal((await query()).length, 3);
  assert.equal(stats, 4, 'not cached: the second poll read again');
  body = new TextEncoder().encode('gauge_id,name\n"half-written');
  clock.advance(10_000);
  const err = await rejects(query(), 'MALFORMED', 'changed while it was read');
  assert.equal(err.retryable, true);
});

// ── readers ──────────────────────────────────────────────────────────────────

test('xml: entities, CDATA and comments; a DOCTYPE is skipped and its entities never expanded', () => {
  const r = parseXml(
    '<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>' +
      "<!-- note --><root x='1' y=2><t>&lt;&amp;&gt; &#233;&#x1F30A; &b;</t><c><![CDATA[<raw> & ]]></c></root>",
  );
  assert.ok('root' in r);
  assert.equal(r.root.attrs['x'], '1');
  assert.equal(r.root.attrs['y'], '2');
  assert.equal(r.root.children[0]!.text, '<&> é🌊 &b;');
  assert.equal(r.root.children[1]!.text, '<raw> & ');
});

test('xml: tolerant of stray end tags and unclosed elements; strict about no root, unclosed tags and caps', () => {
  const r = parseXml('<a><b>one</c></b><d>two</a>');
  assert.ok('root' in r);
  assert.deepEqual(
    r.root.children.map((c) => c.name),
    ['b', 'd'],
  );
  assert.deepEqual(parseXml('just text'), { malformed: 'no root element' });
  assert.ok('malformed' in parseXml('<a x="1'));
  assert.ok('malformed' in parseXml('<a><!-- never closed'));
  assert.ok('malformed' in parseXml('<a>' + '<b>'.repeat(300)));
  assert.ok('malformed' in parseXml('<a>' + '<b/>'.repeat(20), { maxElements: 10 }));
});

test('gpx: GPX 1.0 links, times without a zone as UTC, a one-point track as a Point, a track without points skipped', () => {
  const r = readGpx(
    '<gpx version="1.0"><wpt lat="21" lon="-157"><time>2026-09-23T10:00:00</time><url>https://example.org/w</url></wpt>' +
      '<trk><name>Stationary</name><trkseg><trkpt lat="21.1" lon="-157.1"><time>2026-09-23T10:05:00+10:00</time></trkpt></trkseg></trk>' +
      '<trk><name>Empty</name><trkseg></trkseg></trk></gpx>',
  );
  assert.ok(!('malformed' in r));
  assert.equal(r.features[0]!.time, '2026-09-23T10:00:00.000Z');
  assert.equal(r.features[0]!.properties['link'], 'https://example.org/w');
  assert.equal(r.features[1]!.geometry?.type, 'Point');
  assert.equal(r.features[1]!.time, '2026-09-23T00:05:00.000Z');
  assert.deepEqual(r.skipped, [{ id: 'track-2', reason: 'the track has no valid points' }]);
  assert.deepEqual(readGpx('<kml/>'), { malformed: 'not GPX: the root element is <kml>' });
});

test('kml: homogeneous MultiGeometry, nested folders, Model, mismatched gx:Track, a Placemark with no geometry', () => {
  const r = readKml(
    '<kml><Document><Folder><name>Outer</name><Folder><name>Inner</name>' +
      '<Placemark><name>Pair</name><MultiGeometry><Point><coordinates>1,2</coordinates></Point><Point><coordinates>3,4</coordinates></Point></MultiGeometry></Placemark>' +
      '</Folder><Placemark><name>Model</name><Model><Location><longitude>-157.8</longitude><latitude>21.3</latitude><altitude>12</altitude></Location></Model></Placemark></Folder>' +
      '<Placemark><gx:Track><when>2026-01-01T00:00:00Z</when><gx:coord>1 2 0</gx:coord><gx:coord>3 4 0</gx:coord></gx:Track></Placemark>' +
      '<Placemark><name>No geometry</name></Placemark></Document></kml>',
  );
  assert.ok(!('malformed' in r));
  assert.deepEqual(r.features[0]!.geometry, {
    type: 'MultiPoint',
    coordinates: [
      [1, 2],
      [3, 4],
    ],
  });
  assert.equal(r.features[0]!.properties['folder'], 'Inner');
  assert.equal(r.features[0]!.properties['mixedGeometry'], undefined);
  assert.deepEqual(r.features[1]!.geometry, { type: 'Point', coordinates: [-157.8, 21.3, 12] });
  assert.equal(r.features[1]!.properties['folder'], 'Outer');
  assert.deepEqual(r.skipped, [
    { id: 'placemark-3', reason: 'a gx:Track has 1 <when> for 2 <gx:coord>' },
    { id: 'placemark-4', reason: 'the placemark has no geometry' },
  ]);
});

test('topojson: arcs shared and reversed, layer selection, an unknown layer, an unquantized topology', () => {
  const text = fixture('districts.topojson').toString('utf8');
  const all = readTopoJson(text);
  assert.ok(!('malformed' in all));
  const east = all.features.find((f) => f.id === 'd-east')!;
  assert.deepEqual(east.geometry, {
    type: 'Polygon',
    coordinates: [
      [
        [-157.8, 21.25],
        [-157.7, 21.25],
        [-157.7, 21.35],
        [-157.8, 21.35],
        [-157.8, 21.25],
      ],
    ],
  });
  const west = all.features.find((f) => f.id === 'd-west')!;
  assert.deepEqual(west.geometry, {
    type: 'Polygon',
    coordinates: [
      [
        [-157.8, 21.35],
        [-157.9, 21.35],
        [-157.9, 21.25],
        [-157.8, 21.25],
        [-157.8, 21.35],
      ],
    ],
  });
  const only = readTopoJson(text, { layers: ['landmarks'] });
  assert.ok(!('malformed' in only));
  assert.deepEqual(
    only.features.map((f) => f.id),
    ['landmarks-1'],
  );
  assert.deepEqual(readTopoJson(text, { layers: ['roads'] }), {
    malformed: 'the topology has no object named roads (it has districts, landmarks)',
  });
  const plain = readTopoJson(
    JSON.stringify({
      type: 'Topology',
      objects: { l: { type: 'MultiLineString', arcs: [[0], [~0]] } },
      arcs: [
        [
          [-157.8, 21.3],
          [-157.7, 21.4],
        ],
      ],
    }),
  );
  assert.ok(!('malformed' in plain));
  assert.deepEqual(plain.features[0]!.geometry, {
    type: 'MultiLineString',
    coordinates: [
      [
        [-157.8, 21.3],
        [-157.7, 21.4],
      ],
      [
        [-157.7, 21.4],
        [-157.8, 21.3],
      ],
    ],
  });
});

test('a .json file is TopoJSON or GeoJSON by its content; a single Feature file is one record', async () => {
  const topo = fixture('districts.topojson');
  const provider = new LocalFileProvider(
    definitionOf(withFile('topojson-districts.json', { path: 'gis/districts.json' })),
    {
      source: () => ({ stat: async () => ({ size: topo.length, mtimeMs: NOW }), load: async () => topo }),
    },
  );
  const { query } = await started(provider, new testing.FixtureLocalAccess());
  assert.equal((await query()).length, 3);
  const feature = new TextEncoder().encode(
    JSON.stringify({
      type: 'Feature',
      id: 'one',
      properties: { name: 'Solo' },
      geometry: { type: 'Point', coordinates: [-157.8, 21.3] },
    }),
  );
  const single = new LocalFileProvider(
    definitionOf(withFile('geojson-community-gardens.json', { path: 'gis/one.json' })),
    {
      source: () => ({ stat: async () => ({ size: feature.length, mtimeMs: NOW }), load: async () => feature }),
    },
  );
  const s = await started(single, new testing.FixtureLocalAccess());
  assert.deepEqual(
    (await s.query()).map((o) => o.externalId),
    ['one'],
  );
});

test('text decoding: BOMs, a declared XML encoding, and Windows-1252 when a file is not UTF-8', () => {
  const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('<kml/>').flatMap((c) => [c.charCodeAt(0), 0])]);
  assert.deepEqual(decodeText(utf16, true), { text: '<kml/>', encoding: 'utf-16le' });
  const latin = new Uint8Array([
    ...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><n>'),
    0xe9,
    ...new TextEncoder().encode('</n>'),
  ]);
  assert.equal(decodeText(latin, true).text, '<?xml version="1.0" encoding="ISO-8859-1"?><n>é</n>');
  const cp1252 = new Uint8Array([...new TextEncoder().encode('id,name\nA,Caf'), 0xe9, 0x20, 0x80]);
  assert.deepEqual(decodeText(cp1252, false), { text: 'id,name\nA,Café €', encoding: 'windows-1252', fallback: true });
  assert.deepEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), false), { text: 'a', encoding: 'utf-8' });
});

test('validation: what a local-file definition may not say', () => {
  const errors = (doc: unknown) => {
    const v = new FileSuiteRegistry().validate(doc);
    return v.ok ? [] : v.errors;
  };
  const csv = example('csv-rain-gauges.json');
  const { position: _position, ...noPosition } = csv['mapping'] as Record<string, unknown>;
  assert.match(errors({ ...csv, mapping: noPosition }).join('; '), /never geocoded/);
  assert.match(
    errors(withFile('csv-rain-gauges.json', { path: 'exports/gauges.xlsx' })).join('; '),
    /file\.format is needed/,
  );
  assert.match(errors({ ...csv, endpoint: { url: 'https://example.org/a.csv' } }).join('; '), /endpoint is not used/);
  assert.match(errors({ ...csv, boundsQuery: true }).join('; '), /boundsQuery/);
  assert.match(errors(withFile('csv-rain-gauges.json', { intervalSeconds: 1 })).join('; '), /file\.intervalSeconds/);
  assert.match(errors(withFile('topojson-districts.json', { layers: ['-oops'] })).join('; '), /file\.layers/);
  const { file: _file, ...noFile } = csv;
  assert.match(errors(noFile).join('; '), /needs a "file" block/);
  const v = validateLocalFile(definitionOf(example('geojson-community-gardens.json')));
  assert.ok(v.ok);
  assert.ok(v.warnings.some((w) => /file-time/.test(w)));
});

// ── gdal-import ──────────────────────────────────────────────────────────────

test('gdal-import validation: self-contained formats only; VRT and friends refused; formats local-file reads sent there', () => {
  const doc = example('gdal-parcels.json');
  const at = (p: string, extra: Record<string, unknown> = {}) =>
    validateGdalImport({ ...definitionOf(doc), file: { path: p, ...extra } } as never);
  assert.ok(at('gis/parcels/parcels.shp').ok);
  assert.ok(at('gis/city.gpkg').ok);
  assert.ok(at('gis/city.gdb').ok);
  assert.match(at('gis/mosaic.vrt').errors.join('; '), /can point at other files/);
  assert.match(at('gis/roads.gml').errors.join('; '), /can point at other files/);
  assert.match(at('gps/run.gpx').errors.join('; '), /read by the local-file connector/);
  assert.match(at('gis/roads.dwg').errors.join('; '), /not a format gdal-import converts/);
  assert.match(at('gis/a.shp', { format: 'geojson' }).errors.join('; '), /file\.format is not used/);
});

test('gdal-import without ogr2ogr is OFFLINE with a message, and looks again only after five minutes', async () => {
  let detects = 0;
  const converter: Ogr2ogrAccess = {
    detect: async () => {
      detects++;
      return { found: false, reason: 'ogr2ogr is not on PATH' };
    },
    datasetStat: async () => assert.fail('no stat without ogr2ogr'),
    toGeoJson: async () => assert.fail('no conversion without ogr2ogr'),
  };
  const provider = new GdalImportProvider(definitionOf(example('gdal-parcels.json')), { converter: () => converter });
  const { clock, query } = await started(provider, new testing.FixtureLocalAccess());
  await rejects(query(), 'OFFLINE', 'install GDAL');
  assert.equal((await provider.health()).status, 'OFFLINE');
  clock.advance(60_000);
  await rejects(query(), 'OFFLINE');
  assert.equal(detects, 1);
  clock.advance(5 * 60_000);
  await rejects(query(), 'OFFLINE');
  assert.equal(detects, 2);
});

test('gdal-import on a host without the converter amendment reports UNSUPPORTED', async () => {
  const provider = new GdalImportProvider(definitionOf(example('gdal-parcels.json')));
  const { query } = await started(provider, new testing.FixtureLocalAccess());
  await rejects(query(), 'UNSUPPORTED', 'ogr2ogr');
});

test('gdal-import converts several layers one at a time and keeps their ids apart', async () => {
  const layer = (name: string, n: number) =>
    new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        name,
        features: Array.from({ length: n }, (_, i) => ({
          type: 'Feature',
          id: i,
          properties: { PARCEL_ID: `${name}-${i}` },
          geometry: { type: 'Point', coordinates: [-157.8 + i / 100, 21.3] },
        })),
      }),
    );
  const asked: Array<string | undefined> = [];
  const converter: Ogr2ogrAccess = {
    detect: async () => ({ found: true, version: '3.9.2' }),
    datasetStat: async () => ({ size: 1, mtimeMs: NOW }),
    toGeoJson: async (req) => {
      asked.push(req.layer);
      return layer(req.layer!, req.layer === 'roads' ? 2 : 1);
    },
  };
  const doc = withFile('gdal-parcels.json', { path: 'gis/city.gpkg', layers: ['roads', 'parks'] });
  const provider = new GdalImportProvider(
    definitionOf({ ...doc, mapping: { ...(doc['mapping'] as object), externalId: 'id' } }),
    { converter: () => converter },
  );
  const { query } = await started(provider, new testing.FixtureLocalAccess());
  const obs = await query();
  assert.deepEqual(asked, ['roads', 'parks']);
  assert.deepEqual(obs.map((o) => o.externalId).sort(), ['parks-0', 'roads-0', 'roads-1']);
  const merged = JSON.parse(new TextDecoder().decode(mergeLayers([{ layer: 'a', bytes: layer('a', 1) }]))) as {
    features: Array<{ id: string; layer: string }>;
  };
  assert.deepEqual(
    merged.features.map((f) => [f.id, f.layer]),
    [['a-0', 'a']],
  );
});

// ── the ogr2ogr host (A3) with a stand-in program ────────────────────────────

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
  const output = put(tempDir(t), 'out.geojson', fixture('parcels-ogr2ogr.geojson'));
  return { folder, output };
}

test('ogr2ogr host: fixed arguments, no shell, no WORLDVIEW secrets in its environment, the temporary folder removed', async (t) => {
  const { folder, output } = shapefileFolder(t);
  const s = standIn(t, 'ok', output);
  const tmp = tempDir(t, 'wv-ogr-tmp-');
  const opts: Ogr2ogrHostOptions = {
    folder,
    program: s.program,
    env: { ...SYSTEM_ENV, GDAL_DATA: '/opt/gdal', ONEVIEW_SECRET_FIRMS: 'do-not-leak', AWS_SECRET_ACCESS_KEY: 'x' },
    tmpDir: tmp,
  };
  const host = createOgr2ogrAccess(opts);
  assert.deepEqual(await host.detect(), { found: true, version: '3.9.2-standin' });
  const bytes = await host.toGeoJson({ input: 'gis/parcels/parcels.shp', layer: 'parcels', timeoutMs: 20_000 });
  assert.equal(new TextDecoder().decode(bytes), fixture('parcels-ogr2ogr.geojson').toString('utf8'));
  const call = s.calls()[1]!;
  assert.deepEqual(call.args.slice(0, 6), ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-lco', 'RFC7946=YES']);
  assert.ok(call.args[6]!.startsWith(tmp), 'the output goes to a fresh temporary folder');
  assert.equal(call.args[7], path.join(realpathSync.native(folder), 'gis', 'parcels', 'parcels.shp'));
  assert.equal(call.args[8], 'parcels');
  assert.equal(call.args.length, 9);
  assert.ok(call.env.includes('GDAL_DATA'));
  assert.ok(!call.env.includes('ONEVIEW_SECRET_FIRMS'), 'a WORLDVIEW secret reached ogr2ogr');
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

test('gdal-import end to end: granted folder, the host running a stand-in ogr2ogr, re-conversion only when a part changed', async (t) => {
  const { folder, output } = shapefileFolder(t);
  const s = standIn(t, 'ok', output);
  const grant = createGrantedFolderAccess({ folder });
  const local = { ...grant, ogr2ogr: createOgr2ogrAccess({ folder, program: s.program, env: SYSTEM_ENV }) };
  const provider = new GdalImportProvider(definitionOf(example('gdal-parcels.json')));
  const { clock, context, query } = await started(provider, local);
  const obs: Observation[] = await query();
  assert.deepEqual(
    obs.map((o) => o.externalId),
    ['1-2-003-004', '1-2-003-005'],
  );
  assert.equal(obs[0]!.payload['zoning'], 'R-5');
  assert.equal(provider.detected?.found, true);
  assert.ok(
    context.logger.entries.some((e) => e.message === 'ogr2ogr found' && e.fields?.['version'] === '3.9.2-standin'),
  );
  const conversions = () => s.calls().filter((c) => c.args[0] !== '--version').length;
  assert.equal(conversions(), 1);
  clock.advance(300_000);
  await query();
  assert.equal(conversions(), 1, 'unchanged parts: no conversion');
  writeFileSync(path.join(folder, 'gis', 'parcels', 'parcels.shx'), 'stand-in shx bytes, rewritten');
  clock.advance(300_000);
  await query();
  assert.equal(conversions(), 2, 'a changed part: converted again');
});
