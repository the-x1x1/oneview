import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/**
 * The file connectors over the SDK's fixture granted folder (`testing.FixtureLocalAccess`,
 * which answers as the host does) and the fixture converter (`testing.FixtureOgr2ogr`). The
 * host itself — real links, junctions, a FIFO, a stand-in ogr2ogr process — is tested where
 * it lives, in `packages/runtime/src/support/granted-folder.test.ts`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const examplesDir = path.join(root, 'connectors', 'examples', 'files');
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'connectors', 'files', name));
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(examplesDir, name), 'utf8')) as Record<string, unknown>;
const NOW = Date.parse('2026-09-23T20:00:00.000Z');

/** A fixture folder holding `files` (keys are `/`-separated relative paths), each dated `mtimeMs`. */
function folder(files: Record<string, string | Uint8Array>, mtimeMs = NOW - 3_600_000): testing.FixtureLocalAccess {
  const local = new testing.FixtureLocalAccess(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v]),
    ),
  );
  for (const k of Object.keys(files)) local.mtimes[k] = mtimeMs;
  return local;
}

/** Reads and stats a provider made through a fixture folder, in total. */
const counts = (local: testing.FixtureLocalAccess) => ({
  stat: Object.values(local.stats).reduce((n, c) => n + c, 0),
  read: Object.values(local.reads).reduce((n, c) => n + c, 0),
});

/** A host that grants no folder at all (no `statGrantedFile`): what a build without the amendment looked like. */
function noFolderHost(): ProviderLocalAccess {
  return {
    readGrantedFile: async () => {
      throw new ProviderError('UNSUPPORTED', 'no folder', { retryable: false });
    },
    probeLocal: async () => ({ reachable: false }),
  };
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
  const v = defaultConnectorRegistry.validate(doc);
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
  test(`shared connector suite: ${file} (file mode)`, async (t) => {
    const fixtures = loadSidecar(path.join(examplesDir, file.replace(/\.json$/, '.test.json')), root);
    const r = await runConnectorSuite(example(file), fixtures);
    for (const line of formatSuite(r).split('\n')) t.diagnostic(line);
    assert.ok(r.passed, '\n' + formatSuite(r));
    assert.equal(r.checks.length, 14);
  });
}

test('the suite in file mode fails when it should: a wrong count, an accepted malformed body, a wrong attribution, an escaping path', async () => {
  const name = 'gpx-diamond-head-walk';
  const fixtures = loadSidecar(path.join(examplesDir, `${name}.test.json`), root);
  const doc = example(`${name}.json`);
  const failed = async (d: unknown, f: typeof fixtures) =>
    (await runConnectorSuite(d, f)).checks.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(await failed(doc, { ...fixtures, expectObservations: 5 }), ['Successful parse']);
  assert.deepEqual(await failed(doc, { ...fixtures, malformed: ['<gpx><wpt lat="1" lon="2"/></gpx>'] }), [
    'Malformed response',
  ]);
  assert.deepEqual(await failed({ ...doc, attribution: { text: 'someone else' } }, fixtures), ['Successful parse']);
  assert.deepEqual(await failed({ ...doc, file: { path: '../x.gpx' } }, fixtures), ['Config validation']);
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
    const r = defaultConnectorRegistry.validate(withFile('gpx-diamond-head-walk.json', { path: bad }));
    assert.equal(r.ok, false, bad);
    assert.match(r.errors.join('; '), /file\.path/);
    assert.throws(
      () =>
        new LocalFileProvider({ ...definitionOf(example('gpx-diamond-head-walk.json')), file: { path: bad } } as never),
    );
  }
});

// ── the provider over a fixture folder: mtime polling, caps, file time ───────

test('local-file polls the modification time and re-reads only when the file changed, never more often than every 5 s', async () => {
  const firstMtime = Date.parse('2026-09-23T18:00:00.000Z');
  const local = folder({ 'gps/diamond-head-walk.gpx': fixture('diamond-head-walk.gpx') }, firstMtime);
  const provider = new LocalFileProvider(definitionOf(example('gpx-diamond-head-walk.json')));
  const { clock, query } = await started(provider, local);

  const first = await query();
  assert.equal(first.length, 4);
  assert.deepEqual(counts(local), { stat: 2, read: 1 });
  const waypoint2 = first.find((o) => o.externalId === 'waypoint-2')!;
  assert.equal(
    waypoint2.observedAt,
    new Date(firstMtime).toISOString(),
    'a record without a time is dated by the file',
  );
  assert.deepEqual(waypoint2.quality.flags, ['file-time']);

  clock.advance(1_000);
  assert.equal(await query(), first, 'within 5 s the cached observations are served without looking');
  assert.deepEqual(counts(local), { stat: 2, read: 1 });

  clock.advance(30_000);
  const unchanged = await query();
  assert.deepEqual(counts(local), { stat: 3, read: 1 }, 'an unchanged file is looked at, not read');
  assert.deepEqual(
    unchanged.map((o) => o.id),
    first.map((o) => o.id),
    'an unchanged file yields the same observations',
  );
  assert.equal((await provider.health()).status, 'LIVE');

  const text = fixture('diamond-head-walk.gpx')
    .toString('utf8')
    .replace('<rte>', '<wpt lat="21.2650" lon="-157.8080"><name>Added later</name></wpt>\n  <rte>');
  local.files['gps/diamond-head-walk.gpx'] = new TextEncoder().encode(text);
  const secondMtime = Date.parse('2026-09-23T19:30:00.000Z');
  local.mtimes['gps/diamond-head-walk.gpx'] = secondMtime;
  clock.advance(30_000);
  const changed = await query();
  assert.deepEqual(counts(local), { stat: 5, read: 2 });
  assert.equal(changed.length, 5);
  const added = changed.find((o) => o.externalId === 'waypoint-4');
  assert.equal(added?.payload['name'], 'Added later');
  assert.equal(added?.observedAt, new Date(secondMtime).toISOString());
  const h = await provider.health();
  assert.equal(h.status, 'LIVE');
  assert.match(h.message ?? '', /1 record\(s\) in gps\/diamond-head-walk\.gpx rejected/);

  // Gone: the error is reported, and a refresh a second later does not bring the old objects back.
  delete local.files['gps/diamond-head-walk.gpx'];
  clock.advance(30_000);
  await rejects(query(), 'UNSUPPORTED', 'does not exist');
  clock.advance(1_000);
  await rejects(query(), 'UNSUPPORTED', 'does not exist');
  assert.equal((await provider.health()).status, 'DEGRADED');
});

test('local-file refuses a file over its size cap before reading it, and a path the host refuses', async () => {
  const small = new LocalFileProvider(definitionOf(withFile('gpx-diamond-head-walk.json', { maxBytes: 1024 })));
  const local = folder({ 'gps/diamond-head-walk.gpx': fixture('diamond-head-walk.gpx') });
  const s = await started(small, local);
  await rejects(s.query(), 'TOO_LARGE', 'the limit is 1024');
  assert.equal(counts(local).read, 0, 'the size is known from the stat: nothing is read');
  assert.equal((await small.health()).status, 'ERROR');

  // What the host answers for a link out of the folder surfaces unchanged.
  const refusing = folder({ 'linked/walk.gpx': fixture('diamond-head-walk.gpx') });
  refusing.refuseFiles = new ProviderError('HOST_NOT_ALLOWED', 'linked/walk.gpx leads outside the granted folder', {
    retryable: false,
  });
  const linked = new LocalFileProvider(
    definitionOf(withFile('gpx-diamond-head-walk.json', { path: 'linked/walk.gpx' })),
  );
  const l = await started(linked, refusing);
  await rejects(l.query(), 'HOST_NOT_ALLOWED', 'leads outside the granted folder');
});

test('local-file on a host that grants no folder reports UNSUPPORTED and reads nothing', async () => {
  const provider = new LocalFileProvider(definitionOf(example('gpx-diamond-head-walk.json')));
  const { query } = await started(provider, noFolderHost());
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
    const v = defaultConnectorRegistry.validate(doc);
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

test('gdal-import on a host without a converter reports UNSUPPORTED', async () => {
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

// ── gdal-import end to end, on the fixture converter ─────────────────────────

test('gdal-import end to end: the granted folder, the host converting, re-conversion only when a part changed', async () => {
  const local = folder({}, NOW - 3_600_000);
  const converter = new testing.FixtureOgr2ogr({
    detection: { found: true, version: '3.9.2' },
    outputs: { 'gis/parcels/parcels.shp': fixture('parcels-ogr2ogr.geojson') },
    mtimes: { 'gis/parcels/parcels.shp': NOW - 3_600_000 },
  });
  local.ogr2ogr = converter;
  const provider = new GdalImportProvider(definitionOf(example('gdal-parcels.json')));
  const { clock, context, query } = await started(provider, local);
  const obs: Observation[] = await query();
  assert.deepEqual(
    obs.map((o) => o.externalId),
    ['1-2-003-004', '1-2-003-005'],
  );
  assert.equal(obs[0]!.payload['zoning'], 'R-5');
  assert.equal(provider.detected?.found, true);
  assert.ok(context.logger.entries.some((e) => e.message === 'ogr2ogr found' && e.fields?.['version'] === '3.9.2'));
  assert.equal(converter.calls.length, 1);
  clock.advance(300_000);
  await query();
  assert.equal(converter.calls.length, 1, 'unchanged parts: no conversion');
  converter.mtimes['gis/parcels/parcels.shp'] = NOW - 60_000;
  clock.advance(300_000);
  await query();
  assert.equal(converter.calls.length, 2, 'a changed part: converted again');
});
