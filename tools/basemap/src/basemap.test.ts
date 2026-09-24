import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, gzipSync } from 'node:zlib';
import { ZipWriter, extractWorldPack, verifyWorldPack } from '@worldview/offline';
import {
  BASEMAP_PROVIDER_ID,
  buildBasemap,
  checkSourceUrl,
  loadRegistryEntry,
  parseRegion,
  type BasemapBuildOptions,
} from './build.js';
import {
  PROFILE_SOURCES,
  PROTOMAPS_PROFILE_CLASS,
  REFRESH_SOURCE_NAMES,
  detectJava,
  detectProtomapsJar,
  jarContains,
  jvmOptionsProblem,
  missingSources,
  parseJavaMajor,
  planetilerArgs,
  scrubbedEnv,
  sourcesDir,
  type Exec,
  type FileProbe,
  type Spawn,
} from './planetiler.js';
import { readOsmHeader } from './osm-pbf.js';
import { parsePmtilesHeader, protomapsSchemaProblem, readPmtilesSummary } from './pmtiles.js';

/*
 * Java and Planetiler are replaced by test doubles here (an `exec` that answers
 * `-version`, a `spawn` that writes a small PMTiles file where `--output` says). The
 * PMTiles files, jars and OSM headers below are made up in the published formats; none is
 * a real build. A real run is the operator's (docs/OFFLINE-BASEMAPS.md).
 */

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'wv-basemap-'));
}

/** `java -version` as this project's Linux container printed it, JAVA_TOOL_OPTIONS line included. */
const REAL_JAVA_21 = [
  'Picked up JAVA_TOOL_OPTIONS: -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts',
  'openjdk version "21.0.10" 2026-01-20',
  'OpenJDK Runtime Environment (build 21.0.10+7-Ubuntu-124.04)',
].join('\n');

test('parseJavaMajor reads modern, legacy and bare version strings', () => {
  assert.equal(parseJavaMajor(REAL_JAVA_21), 21);
  assert.equal(parseJavaMajor('java version "1.8.0_392"'), 8);
  assert.equal(parseJavaMajor('openjdk version "22" 2024-03-19'), 22);
  assert.equal(parseJavaMajor('openjdk version "17.0.9" 2023-10-17'), 17);
  assert.equal(parseJavaMajor('no version here'), undefined);
});

function probeOf(files: string[], dirs: Record<string, string[]> = {}): FileProbe {
  return {
    isFile: async (p) => files.includes(p),
    listDir: async (d) => dirs[d] ?? [],
  };
}

function execAnswering(
  answers: Record<string, { stdout?: string; stderr?: string; code?: number; error?: string }>,
): Exec & {
  calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const fn = (async (file, args, opts) => {
    calls.push({ file, args, env: opts.env });
    const a = answers[`${file} ${args.join(' ')}`];
    if (!a) return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
    return {
      code: a.code ?? 0,
      stdout: a.stdout ?? '',
      stderr: a.stderr ?? '',
      ...(a.error ? { error: a.error } : {}),
    };
  }) as Exec & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

test('detectJava skips a too-old JAVA_HOME and takes Java 21 from PATH', async () => {
  const env = { JAVA_HOME: '/jdk17', PATH: '/usr/bin:/opt/bin' };
  const probe = probeOf(['/jdk17/bin/java', '/usr/bin/java']);
  const exec = execAnswering({
    '/jdk17/bin/java -version': { stderr: 'openjdk version "17.0.9" 2023-10-17' },
    '/usr/bin/java -version': { stderr: REAL_JAVA_21 },
  });
  const r = await detectJava({ env, platform: 'linux' }, exec, probe);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.path === '/usr/bin/java' && r.major === 21);
});

test('detectJava says what it tried and never offers to download', async () => {
  const none = await detectJava({ env: { PATH: '/usr/bin' }, platform: 'linux' }, execAnswering({}), probeOf([]));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : '', /does not download/);
  const old = await detectJava(
    { env: { PATH: '/usr/bin' }, platform: 'linux' },
    execAnswering({ '/usr/bin/java -version': { stderr: 'java version "1.8.0_392"' } }),
    probeOf(['/usr/bin/java']),
  );
  assert.equal(old.ok, false);
  assert.match(!old.ok ? old.reason : '', /Java 8, but Planetiler needs 21/);
});

test('detectJava finds java.exe through PATHEXT on Windows, and --java wins over everything', async () => {
  const env = { Path: 'C:\\jdk\\bin;C:\\Windows', PATHEXT: '.COM;.EXE' };
  const exec = execAnswering({
    'C:\\jdk\\bin\\java.exe -version': { stderr: REAL_JAVA_21 },
    'D:\\java\\bin\\java.exe -version': { stderr: REAL_JAVA_21 },
  });
  const found = await detectJava({ env, platform: 'win32' }, exec, probeOf(['C:\\jdk\\bin\\java.exe']));
  assert.ok(found.ok && found.path === 'C:\\jdk\\bin\\java.exe');
  const flagged = await detectJava(
    { env, platform: 'win32', javaFlag: 'D:\\java\\bin\\java.exe' },
    exec,
    probeOf(['C:\\jdk\\bin\\java.exe']),
  );
  assert.ok(flagged.ok && flagged.path === 'D:\\java\\bin\\java.exe');
  const quoted = await detectJava(
    { env: { Path: '"C:\\Program Files\\Java\\bin";C:\\Windows', PATHEXT: '.EXE' }, platform: 'win32' },
    execAnswering({ 'C:\\Program Files\\Java\\bin\\java.exe -version': { stderr: REAL_JAVA_21 } }),
    probeOf(['C:\\Program Files\\Java\\bin\\java.exe']),
  );
  assert.ok(quoted.ok && quoted.path === 'C:\\Program Files\\Java\\bin\\java.exe', 'a quoted PATH entry is unquoted');
});

async function writeJar(file: string, names: string[]): Promise<void> {
  const w = await ZipWriter.create(file);
  for (const n of names) await w.add({ name: n, data: Buffer.from('x'), method: 0 });
  await w.finish();
}

/** A minimal zip64 archive (one stored entry), the shape large `-with-deps` jars take. */
function zip64With(name: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBuf.length, 26);
  const cdEntry = Buffer.alloc(46);
  cdEntry.writeUInt32LE(0x02014b50, 0);
  cdEntry.writeUInt16LE(nameBuf.length, 28);
  const cd = Buffer.concat([cdEntry, nameBuf]);
  const cdOffset = local.length + nameBuf.length;
  const rec = Buffer.alloc(56);
  rec.writeUInt32LE(0x06064b50, 0);
  rec.writeBigUInt64LE(44n, 4);
  rec.writeBigUInt64LE(1n, 24);
  rec.writeBigUInt64LE(1n, 32);
  rec.writeBigUInt64LE(BigInt(cd.length), 40);
  rec.writeBigUInt64LE(BigInt(cdOffset), 48);
  const recOffset = cdOffset + cd.length;
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(recOffset), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([local, nameBuf, cd, rec, locator, eocd]);
}

test('jarContains reads the central directory, zip64 included, without running the jar', async () => {
  const dir = tmp();
  try {
    const good = path.join(dir, 'good.jar');
    const stock = path.join(dir, 'planetiler.jar');
    await writeJar(good, ['META-INF/MANIFEST.MF', PROTOMAPS_PROFILE_CLASS]);
    await writeJar(stock, ['META-INF/MANIFEST.MF', 'com/onthegomap/planetiler/Main.class']);
    assert.equal(await jarContains(good, PROTOMAPS_PROFILE_CLASS), true);
    assert.equal(await jarContains(stock, PROTOMAPS_PROFILE_CLASS), false);
    const z64 = path.join(dir, 'big.jar');
    writeFileSync(z64, zip64With(PROTOMAPS_PROFILE_CLASS));
    assert.equal(await jarContains(z64, PROTOMAPS_PROFILE_CLASS), true);
    const junk = path.join(dir, 'junk.jar');
    writeFileSync(junk, Buffer.from('not a zip at all, not even close'));
    assert.equal(await jarContains(junk, PROTOMAPS_PROFILE_CLASS), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectProtomapsJar tells the profile from a stock Planetiler jar by its contents and never runs either', async () => {
  const dir = tmp();
  try {
    const good = path.join(dir, 'protomaps-basemap-HEAD-with-deps.jar');
    const stock = path.join(dir, 'planetiler.jar');
    await writeJar(good, [PROTOMAPS_PROFILE_CLASS]);
    await writeJar(stock, ['com/onthegomap/planetiler/Main.class']);
    const refused = await detectProtomapsJar({ jarFlag: stock, env: {}, platform: 'linux' });
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.reason : '', /OpenMapTiles/);

    const onPath = await detectProtomapsJar({ env: { PATH: dir }, platform: 'linux' });
    assert.ok(onPath.ok && onPath.path === good);
    assert.equal(onPath.ok && onPath.sha256, createHash('sha256').update(readFileSync(good)).digest('hex'));

    const fromEnv = await detectProtomapsJar({ env: { ONEVIEW_PLANETILER_JAR: good, PATH: '' }, platform: 'linux' });
    assert.ok(fromEnv.ok && fromEnv.path === good);
    const none = await detectProtomapsJar({ env: { PATH: path.join(dir, 'empty') }, platform: 'linux' });
    assert.match(!none.ok ? none.reason : '', /does not download it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('jvmOptionsProblem refuses planetiler.* properties in the Java launcher variables', () => {
  assert.equal(jvmOptionsProblem({ JAVA_TOOL_OPTIONS: '-Djavax.net.ssl.trustStore=/etc/ssl/cacerts' }), undefined);
  assert.match(jvmOptionsProblem({ JAVA_TOOL_OPTIONS: '-Dplanetiler.refresh_osm=true' }) ?? '', /JAVA_TOOL_OPTIONS/);
  assert.match(jvmOptionsProblem({ JDK_JAVA_OPTIONS: '-DPlanetiler.config=x.properties' }) ?? '', /JDK_JAVA_OPTIONS/);
  assert.match(jvmOptionsProblem({ _java_options: '-Dplanetiler.download=true' }) ?? '', /_JAVA_OPTIONS/);
});

test('planetilerArgs: every input explicit, every download switch off, no URL anywhere', () => {
  const args = planetilerArgs({
    jar: '/j/pm.jar',
    osmPath: '/x/hawaii-latest.osm.pbf',
    workDir: '/w',
    output: '/w/out/basemap-hawaii.pmtiles',
    bounds: { west: -161, south: 18.5, east: -154.5, north: 22.5 },
    maxZoom: 14,
    memory: '4g',
    threads: 4,
  });
  assert.deepEqual(args.slice(0, 3), ['-Xmx4g', '-jar', '/j/pm.jar']);
  for (const off of [
    '--download=false',
    '--only_download=false',
    '--refresh_sources=false',
    '--fetch_wikidata=false',
    ...REFRESH_SOURCE_NAMES.map((n) => `--refresh_${n}=false`),
  ])
    assert.ok(args.includes(off), off);
  assert.deepEqual(REFRESH_SOURCE_NAMES, ['osm', 'ne', 'osm_water', 'osm_land', 'landcover']);
  assert.ok(!args.includes('--download'));
  assert.ok(!args.some((a) => /https?:\/\//.test(a)), 'no URL is ever handed to Planetiler');
  assert.ok(args.includes('--osm_path=/x/hawaii-latest.osm.pbf'));
  assert.ok(args.includes('--bounds=-161,18.5,-154.5,22.5'));
  assert.ok(args.includes('--maxzoom=14'));
  assert.ok(args.includes('--threads=4'));
  for (const s of PROFILE_SOURCES.filter((p) => p.arg))
    assert.ok(args.includes(`--${s.arg}=${path.join('/w', 'data', 'sources', s.file)}`), s.file);
});

test('scrubbedEnv drops Planetiler settings in any case and keeps the rest', () => {
  const env = scrubbedEnv({
    PATH: '/bin',
    PLANETILER_DOWNLOAD: 'true',
    planetiler_refresh_sources: 'true',
    HOME: '/h',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('missingSources names every profile input until it is on disk', async () => {
  const dir = tmp();
  try {
    assert.equal((await missingSources(dir)).length, PROFILE_SOURCES.length);
    mkdirSync(sourcesDir(dir), { recursive: true });
    for (const s of PROFILE_SOURCES.slice(1)) writeFileSync(path.join(sourcesDir(dir), s.file), 'x');
    assert.deepEqual(
      (await missingSources(dir)).map((s) => s.file),
      [PROFILE_SOURCES[0]!.file],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRegion: presets, a bounding box, and what is refused', () => {
  const hawaii = parseRegion('hawaii');
  assert.ok(!('error' in hawaii) && hawaii.bounds.west === -161);
  const box = parseRegion('-157.9, 21.2, -157.6, 21.5');
  assert.ok(!('error' in box) && box.bounds.north === 21.5 && box.label === 'bbox');
  assert.ok('error' in parseRegion('atlantis'));
  assert.ok('error' in parseRegion('1,2,3'));
  assert.ok('error' in parseRegion('170,10,-170,20'), 'across the antimeridian');
  assert.ok('error' in parseRegion('0,95,1,96'));
});

test('checkSourceUrl records https URLs only, without credentials', () => {
  assert.equal(checkSourceUrl('https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf'), undefined);
  assert.match(checkSourceUrl('http://download.geofabrik.de/x.osm.pbf') ?? '', /https/);
  assert.match(checkSourceUrl('https://u:p@example.org/x.osm.pbf') ?? '', /credentials/);
  assert.match(checkSourceUrl('not a url') ?? '', /not a URL/);
});

/** A PMTiles v3 file in the published layout: header, then gzip JSON metadata; no tile data. */
function pmtilesBytes(opts: {
  layers: string[];
  tileType?: number;
  bounds?: [number, number, number, number];
  tiles?: number;
  attribution?: string;
}): Buffer {
  const meta = gzipSync(
    Buffer.from(
      JSON.stringify({
        name: 'Protomaps Basemap',
        attribution: opts.attribution ?? '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
        vector_layers: opts.layers.map((id) => ({ id, fields: {} })),
      }),
    ),
  );
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'ascii');
  h[7] = 3;
  h.writeBigUInt64LE(127n, 8);
  h.writeBigUInt64LE(127n, 24);
  h.writeBigUInt64LE(BigInt(meta.length), 32);
  h.writeBigUInt64LE(BigInt(opts.tiles ?? 1234), 72);
  h[97] = 2;
  h[98] = 2;
  h[99] = opts.tileType ?? 1;
  h[100] = 0;
  h[101] = 15;
  const [w, s, e, n] = opts.bounds ?? [-161, 18.5, -154.5, 22.5];
  h.writeInt32LE(Math.round(w * 1e7), 102);
  h.writeInt32LE(Math.round(s * 1e7), 106);
  h.writeInt32LE(Math.round(e * 1e7), 110);
  h.writeInt32LE(Math.round(n * 1e7), 114);
  return Buffer.concat([h, meta]);
}

const PROTOMAPS_LAYERS = [
  'boundaries',
  'buildings',
  'earth',
  'landcover',
  'landuse',
  'places',
  'pois',
  'roads',
  'transit',
  'water',
];

test('readPmtilesSummary reads the header and the metadata; the schema check wants Protomaps layers', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'a.pmtiles');
    writeFileSync(f, pmtilesBytes({ layers: PROTOMAPS_LAYERS }));
    const s = await readPmtilesSummary(f);
    assert.equal(s.tileType, 'mvt');
    assert.equal(s.maxZoom, 15);
    assert.equal(s.addressedTiles, 1234);
    assert.equal(s.bounds.west, -161);
    assert.deepEqual(s.vectorLayers, PROTOMAPS_LAYERS);
    assert.equal(s.metadata.name, 'Protomaps Basemap');
    assert.equal(protomapsSchemaProblem(s), undefined);

    writeFileSync(f, pmtilesBytes({ layers: ['water', 'landcover', 'transportation', 'place', 'boundary'] }));
    assert.match(
      protomapsSchemaProblem(await readPmtilesSummary(f)) ?? '',
      /earth, roads, places, boundaries are missing/,
    );
    writeFileSync(f, pmtilesBytes({ layers: PROTOMAPS_LAYERS, tileType: 2 }));
    assert.match(protomapsSchemaProblem(await readPmtilesSummary(f)) ?? '', /png/);
    writeFileSync(f, pmtilesBytes({ layers: PROTOMAPS_LAYERS, tiles: 0 }));
    assert.match(protomapsSchemaProblem(await readPmtilesSummary(f)) ?? '', /no tiles/);
    const brotli = pmtilesBytes({ layers: PROTOMAPS_LAYERS });
    brotli[97] = 3;
    writeFileSync(f, brotli);
    assert.match(
      protomapsSchemaProblem(await readPmtilesSummary(f)) ?? '',
      /brotli-compressed, which this tool does not read/,
    );
    assert.throws(() => parsePmtilesHeader(Buffer.from('PMTiles')), /shorter/);
    assert.throws(() => parsePmtilesHeader(Buffer.alloc(127)), /not a PMTiles v3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Protobuf helpers for a made-up `.osm.pbf` header in the published layout. */
function varint(n: bigint): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}
function field(num: number, wire: number, payload: Buffer): Buffer {
  const key = varint(BigInt((num << 3) | wire));
  return wire === 2 ? Buffer.concat([key, varint(BigInt(payload.length)), payload]) : Buffer.concat([key, payload]);
}
function sint(deg: number): Buffer {
  const n = BigInt(Math.round(deg * 1e9));
  return varint(n >= 0n ? n << 1n : (-n << 1n) - 1n);
}
function osmPbf(opts: { bbox?: [number, number, number, number]; compress?: boolean; type?: string } = {}): Buffer {
  const parts: Buffer[] = [];
  if (opts.bbox) {
    const [w, so, e, n] = opts.bbox;
    parts.push(
      field(
        1,
        2,
        Buffer.concat([field(1, 0, sint(w)), field(2, 0, sint(e)), field(3, 0, sint(n)), field(4, 0, sint(so))]),
      ),
    );
  }
  parts.push(field(4, 2, Buffer.from('OsmSchema-V0.6')), field(4, 2, Buffer.from('DenseNodes')));
  parts.push(field(16, 2, Buffer.from('test double')));
  const block = Buffer.concat(parts);
  const blob = opts.compress
    ? Buffer.concat([field(2, 0, varint(BigInt(block.length))), field(3, 2, deflateSync(block))])
    : field(1, 2, block);
  const header = Buffer.concat([
    field(1, 2, Buffer.from(opts.type ?? 'OSMHeader')),
    field(3, 0, varint(BigInt(blob.length))),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, blob, Buffer.alloc(32)]);
}

const HAWAII_EXTRACT: [number, number, number, number] = [-161.5, 18.0, -154.0, 23.0];

test('readOsmHeader reads the extract bounding box, raw or zlib-compressed, and refuses other files', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'x.osm.pbf');
    writeFileSync(f, osmPbf({ bbox: HAWAII_EXTRACT, compress: true }));
    const z = await readOsmHeader(f);
    assert.deepEqual(z.ok && z.bbox, { west: -161.5, south: 18, east: -154, north: 23 });
    writeFileSync(f, osmPbf({ bbox: [139.5, 35.5, 140, 36] }));
    const raw = await readOsmHeader(f);
    assert.deepEqual(raw.ok && raw.bbox, { west: 139.5, south: 35.5, east: 140, north: 36 });
    writeFileSync(f, osmPbf());
    const nobox = await readOsmHeader(f);
    assert.ok(nobox.ok && nobox.bbox === undefined);
    writeFileSync(f, osmPbf({ type: 'OSMData' }));
    assert.equal((await readOsmHeader(f)).ok, false);
    writeFileSync(f, 'PK not an osm file at all, just some text');
    assert.equal((await readOsmHeader(f)).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The registry record docs/OFFLINE-BASEMAPS.md proposes, as the integrator would add it. */
const PROPOSED_RECORD = {
  providerId: BASEMAP_PROVIDER_ID,
  name: 'OpenStreetMap basemap built locally with Planetiler (Protomaps basemap profile)',
  license:
    'Data: ODbL 1.0 (© OpenStreetMap contributors); Protomaps basemap profile BSD-3-Clause, map design CC0; landcover from ESA WorldCover (CC BY 4.0); Natural Earth public domain',
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: true,
    attributionText:
      '© OpenStreetMap contributors, ODbL · Protomaps basemap (BSD-3-Clause) · Landcover: ESA WorldCover (CC BY 4.0)',
    termsUrl: 'https://www.openstreetmap.org/copyright',
  },
};

interface Harness {
  dir: string;
  out: string;
  osm: string;
  osmBytes: Buffer;
  jar: string;
  registry: string;
  spawnCalls: Array<{ file: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }>;
  options(extra?: Partial<BasemapBuildOptions>): BasemapBuildOptions;
}

async function harness(
  opts: {
    record?: boolean;
    pmtiles?: Buffer;
    exitCode?: number;
    sources?: boolean;
    osm?: Buffer;
    /** Called while the fake Planetiler "runs", e.g. to abort. */
    during?: () => void;
  } = {},
): Promise<Harness> {
  const dir = tmp();
  const out = path.join(dir, 'out');
  const work = path.join(out, 'work');
  if (opts.sources !== false) {
    mkdirSync(sourcesDir(work), { recursive: true });
    for (const s of PROFILE_SOURCES) writeFileSync(path.join(sourcesDir(work), s.file), 'input');
  }
  const osm = path.join(dir, 'hawaii-latest.osm.pbf');
  const osmBytes = opts.osm ?? osmPbf({ bbox: HAWAII_EXTRACT, compress: true });
  writeFileSync(osm, osmBytes);
  const jar = path.join(dir, 'protomaps-basemap-HEAD-with-deps.jar');
  await writeJar(jar, [PROTOMAPS_PROFILE_CLASS]);
  const registry = path.join(dir, 'providers.json');
  writeFileSync(registry, JSON.stringify({ records: opts.record === false ? [] : [PROPOSED_RECORD] }));
  const exec = execAnswering({ '/usr/bin/java -version': { stderr: REAL_JAVA_21 } });
  const spawnCalls: Harness['spawnCalls'] = [];
  const spawnFake: Spawn = async (file, args, o) => {
    spawnCalls.push({ file, args, cwd: o.cwd, env: o.env });
    o.onOutput('0:00:01 INF - Planetiler (test double)\n');
    writeFileSync(path.join(o.cwd, 'tmp', 'scratch.bin'), 'temp');
    const output = args.find((a) => a.startsWith('--output='))!.slice('--output='.length);
    writeFileSync(output, opts.pmtiles ?? pmtilesBytes({ layers: PROTOMAPS_LAYERS }));
    if (opts.during) {
      opts.during();
      return { code: null, signal: 'SIGTERM' };
    }
    return { code: opts.exitCode ?? 0, signal: null };
  };
  let t = Date.parse('2026-09-24T19:00:00Z');
  return {
    dir,
    out,
    osm,
    osmBytes,
    jar,
    registry,
    spawnCalls,
    options: (extra = {}) => ({
      region: 'hawaii',
      outDir: out,
      osmPath: osm,
      osmSourceUrl: 'https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf',
      jar,
      registryPath: registry,
      env: { PATH: '/usr/bin', PLANETILER_DOWNLOAD: 'true' },
      platform: 'linux',
      log: () => undefined,
      deps: {
        exec,
        spawn: spawnFake,
        probe: {
          isFile: async (p) => p === '/usr/bin/java' || existsSync(p),
          listDir: async () => [],
        },
        clock: { now: () => (t += 1000) },
      },
      ...extra,
    }),
  };
}

test('buildBasemap: extract → Planetiler → PMTiles → a pack carrying the OSM attribution and the Protomaps licence', async () => {
  const h = await harness();
  try {
    const r = await buildBasemap(h.options());
    assert.ok(r.ok && !r.dryRun, JSON.stringify(r));
    const report = r.report;

    // Planetiler ran once, from the work directory, without its settings from the environment.
    assert.equal(h.spawnCalls.length, 1);
    const call = h.spawnCalls[0]!;
    assert.equal(call.file, '/usr/bin/java');
    assert.equal(call.cwd, path.join(h.out, 'work'));
    assert.equal(call.env.PLANETILER_DOWNLOAD, undefined);
    assert.ok(call.args.includes('--download=false'));

    // The report records what was built from what, including where the extract came from.
    assert.equal(report.osm.sha256, createHash('sha256').update(h.osmBytes).digest('hex'));
    assert.equal(report.osm.sourceUrl, 'https://download.geofabrik.de/north-america/us/hawaii-latest.osm.pbf');
    assert.equal(report.profile.sha256, createHash('sha256').update(readFileSync(h.jar)).digest('hex'));
    assert.deepEqual(report.osm.headerBounds, { west: -161.5, south: 18, east: -154, north: 23 });
    assert.ok(!existsSync(path.join(h.out, 'work', 'tmp')), "Planetiler's scratch directory is removed");
    assert.equal(report.pmtiles.path, path.join(h.out, 'basemap-hawaii.pmtiles'));
    assert.ok(existsSync(report.pmtiles.path));
    assert.ok(existsSync(path.join(h.out, 'basemap-hawaii.planetiler.log')));
    assert.deepEqual(JSON.parse(readFileSync(r.reportPath, 'utf8')).id, 'basemap-hawaii');

    // The pack verifies, is filed under the registry record, and its NOTICES carry the credit.
    assert.ok(report.pack);
    const v = await verifyWorldPack(report.pack.path);
    assert.ok(v.ok, v.issues?.join('; '));
    const policy = v.manifest!.sourcePolicies.find((p) => p.providerId === BASEMAP_PROVIDER_ID);
    assert.ok(policy);
    assert.match(policy.attribution, /© OpenStreetMap contributors, ODbL/);
    assert.match(policy.attribution, /Protomaps basemap \(BSD-3-Clause\)/);
    assert.equal(v.manifest!.contents.find((c) => c.kind === 'pmtiles')?.path, 'maps/basemap-hawaii.pmtiles');
    const extracted = path.join(h.dir, 'extracted');
    await extractWorldPack(report.pack.path, extracted);
    const notices = readFileSync(path.join(extracted, 'licenses', 'NOTICES.md'), 'utf8');
    assert.match(notices, /© OpenStreetMap contributors, ODbL/);
    assert.match(notices, /BSD-3-Clause/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('buildBasemap refuses before Java starts when the registry has no record, and --pmtiles-only needs none', async () => {
  const h = await harness({ record: false });
  try {
    const refused = await buildBasemap(h.options());
    assert.ok(!refused.ok && refused.stage === 'prerequisites');
    assert.match(refused.problems.join('\n'), /no record "osm-protomaps-planetiler"/);
    assert.equal(h.spawnCalls.length, 0);

    const only = await buildBasemap(h.options({ pmtilesOnly: true }));
    assert.ok(only.ok && !only.dryRun);
    assert.equal(only.report.pack, undefined);
    assert.ok(existsSync(only.report.pmtiles.path));
    assert.ok(!existsSync(path.join(h.out, 'basemap-hawaii.worldpack')));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('buildBasemap reports every missing prerequisite at once and never runs Planetiler', async () => {
  const h = await harness({ sources: false });
  try {
    const r = await buildBasemap(h.options({ osmPath: path.join(h.dir, 'missing.osm.pbf') }));
    assert.ok(!r.ok && r.stage === 'prerequisites');
    const text = r.problems.join('\n');
    assert.match(text, /profile inputs missing/);
    assert.match(text, /qrank\.csv\.gz/);
    assert.match(text, /this tool downloads nothing/);
    assert.match(text, /missing\.osm\.pbf is not a readable file/);
    assert.equal(h.spawnCalls.length, 0);

    const { osmPath: _omitted, ...withoutOsm } = h.options();
    const noOsm = await buildBasemap(withoutOsm);
    assert.ok(!noOsm.ok && noOsm.stage === 'arguments');
    assert.match(noOsm.problems.join('\n'), /downloads nothing/);

    writeFileSync(path.join(h.dir, 'fake.osm.pbf'), 'PK not an osm file at all, just some text');
    const notPbf = await buildBasemap(h.options({ osmPath: path.join(h.dir, 'fake.osm.pbf') }));
    assert.match(!notPbf.ok ? notPbf.problems.join('\n') : '', /does not start like an OSM PBF/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('buildBasemap --dry-run checks everything and runs nothing', async () => {
  const h = await harness();
  try {
    const r = await buildBasemap(h.options({ dryRun: true }));
    assert.ok(r.ok && r.dryRun);
    assert.equal(r.command.java, '/usr/bin/java');
    assert.equal(r.command.cwd, path.join(h.out, 'work'));
    assert.ok(r.command.args.includes('--download=false'));
    assert.equal(h.spawnCalls.length, 0);
    assert.ok(!existsSync(path.join(h.out, 'basemap-hawaii.pmtiles')));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('buildBasemap: a failed run or the wrong schema stops before a pack is written', async () => {
  for (const [what, opts, stage, pattern] of [
    ['exit 1', { exitCode: 1 }, 'planetiler', /exited 1/],
    [
      'OpenMapTiles layers',
      { pmtiles: pmtilesBytes({ layers: ['water', 'transportation', 'place'] }) },
      'pmtiles',
      /Protomaps/,
    ],
    [
      'an extract for another region',
      { osm: osmPbf({ bbox: [122.5, 24, 146.5, 46] }) },
      'prerequisites',
      /does not meet the region/,
    ],
    ['a planetiler.* JVM option', {}, 'prerequisites', /JAVA_TOOL_OPTIONS sets a planetiler/],
  ] as const) {
    const h = await harness(opts);
    try {
      const extra: Partial<BasemapBuildOptions> =
        what === 'a planetiler.* JVM option'
          ? { env: { PATH: '/usr/bin', JAVA_TOOL_OPTIONS: '-Dplanetiler.refresh_osm=true' } }
          : {};
      const r = await buildBasemap(h.options(extra));
      assert.ok(!r.ok, what);
      assert.equal(r.stage, stage, what);
      assert.match(r.problems.join('\n'), pattern, what);
      assert.ok(!existsSync(path.join(h.out, 'basemap-hawaii.worldpack')), what);
      if (stage === 'prerequisites') assert.equal(h.spawnCalls.length, 0, what);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test('buildBasemap warns when the extract covers part of the region or does not say what it covers', async () => {
  for (const [osm, pattern] of [
    [osmPbf({ bbox: [-158.5, 20.5, -157.5, 21.8] }), /only part of the region/],
    [osmPbf(), /does not state its bounding box/],
  ] as const) {
    const h = await harness({ osm });
    try {
      const r = await buildBasemap(h.options());
      assert.ok(r.ok && !r.dryRun, JSON.stringify(r));
      assert.match(r.report.warnings.join('\n'), pattern);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test('buildBasemap: an interrupt stops Planetiler, leaves no output and removes its scratch files', async () => {
  const abort = new AbortController();
  const h = await harness({ during: () => abort.abort() });
  try {
    const r = await buildBasemap(h.options({ signal: abort.signal }));
    assert.ok(!r.ok && r.stage === 'interrupted', JSON.stringify(r));
    assert.ok(!existsSync(path.join(h.out, 'basemap-hawaii.pmtiles')));
    assert.ok(!existsSync(path.join(h.out, 'work', 'out', 'basemap-hawaii.pmtiles')));
    assert.ok(!existsSync(path.join(h.out, 'work', 'tmp')));
    const before = new AbortController();
    before.abort();
    const early = await buildBasemap(h.options({ signal: before.signal }));
    assert.ok(!early.ok && early.stage === 'interrupted');
    assert.equal(h.spawnCalls.length, 1, 'an interrupt before the run starts nothing');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('buildBasemap: argument errors come back together', async () => {
  const h = await harness();
  try {
    const r = await buildBasemap(
      h.options({ region: 'atlantis', maxZoom: 20, memory: 'lots', id: 'Bad Id', osmSourceUrl: 'ftp://x/y' }),
    );
    assert.ok(!r.ok && r.stage === 'arguments');
    assert.equal(r.problems.length, 5, r.problems.join('\n'));
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('loadRegistryEntry: a missing record and an incomplete policy are both refusals', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'providers.json');
    writeFileSync(
      f,
      JSON.stringify({ records: [{ providerId: BASEMAP_PROVIDER_ID, dataPolicy: { cacheAllowed: true } }] }),
    );
    assert.match(JSON.stringify(await loadRegistryEntry(f, BASEMAP_PROVIDER_ID)), /no complete dataPolicy/);
    assert.match(JSON.stringify(await loadRegistryEntry(f, 'other')), /no record/);
    assert.match(JSON.stringify(await loadRegistryEntry(path.join(dir, 'nope.json'), 'x')), /cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
