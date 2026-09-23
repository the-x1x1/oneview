import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import { testing } from '@worldview/provider-sdk';
import {
  SEED_AIRPORTS_PROVIDER_ID,
  SEED_PLACES_PROVIDER_ID,
  WorldPackBuildError,
  WorldPackBuilder,
  resolveRegionBounds,
  seedPolicies,
  type WorldPackBuildRequest,
} from './builder.js';
import { REGION_PRESETS } from './region-presets.js';
import { generatePackKeyPair } from './signature.js';
import { readWorldPackManifest, verifyWorldPack } from './verify.js';
import { ZipReader } from './zip.js';
import { PlaceIndex } from './place-index.js';
import { tempDir, writeTemp } from '../test/helpers/raw-zip.js';
import { USGS, USGS_POLICY, seededHistory } from '../test/helpers/history.js';

const { VirtualClock } = testing;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLACES = path.join(root, 'fixtures', 'places', 'seed-places.geojson');
const AIRPORTS = path.join(root, 'fixtures', 'airports', 'seed-airports.geojson');
const PROTOMAPS_POLICY: ProviderDataPolicy = {
  cacheAllowed: true,
  rawPayloadRetentionAllowed: true,
  normalizedRetentionAllowed: true,
  redistributionAllowed: true,
  offlinePackAllowed: true,
  exportAllowed: true,
  commercialUseAllowed: true,
  attributionRequired: true,
  attributionText: 'Protomaps · © OpenStreetMap contributors (ODbL)',
  termsUrl: 'https://docs.protomaps.com/',
};
const NO_REDIST_POLICY: ProviderDataPolicy = {
  ...PROTOMAPS_POLICY,
  redistributionAllowed: false,
  offlinePackAllowed: true,
};
const NO_PACK_POLICY: ProviderDataPolicy = { ...PROTOMAPS_POLICY, offlinePackAllowed: false };

function policies(extra: Record<string, ProviderDataPolicy> = {}): (id: string) => ProviderDataPolicy | undefined {
  const map: Record<string, ProviderDataPolicy> = {
    ...seedPolicies(),
    'protomaps-builds': PROTOMAPS_POLICY,
    [USGS]: USGS_POLICY,
    ...extra,
  };
  return (id) => map[id];
}

/** A PMTiles v3 header stub: 7-byte magic + version byte + zeroed header fields. Test-only stand-in for a real extract. */
function pmtilesStub(): Buffer {
  const b = Buffer.alloc(127);
  b.write('PMTiles', 0, 'ascii');
  b[7] = 3;
  return b;
}

function baseRequest(dir: string, over: Partial<WorldPackBuildRequest> = {}): WorldPackBuildRequest {
  return {
    id: 'hawaii-test',
    name: 'Hawaii test',
    region: { preset: 'hawaii' },
    include: ['places', 'airports'],
    sources: { placesGeoJsonPath: PLACES, airportsGeoJsonPath: AIRPORTS },
    policies: policies(),
    licenses: (id) =>
      id.startsWith('worldview-seed') ? 'MIT' : id === USGS ? 'U.S. Government work — public domain' : 'ODbL 1.0',
    outputPath: path.join(dir, 'hawaii.worldpack'),
    clock: new VirtualClock(Date.parse('2026-09-21T12:00:00Z')),
    ...over,
  };
}

test('builder: region inputs resolve to bounds (preset, bounds, circle) and bad ones are refused', () => {
  assert.deepEqual(resolveRegionBounds({ preset: 'hawaii' }), REGION_PRESETS.find((p) => p.id === 'hawaii')!.bounds);
  assert.deepEqual(resolveRegionBounds({ bounds: { west: 1, south: 2, east: 3, north: 4 } }), {
    west: 1,
    south: 2,
    east: 3,
    north: 4,
  });
  const c = resolveRegionBounds({ center: { latitude: 21.3, longitude: -157.9 }, radiusM: 100_000 });
  assert.ok(c.south < 21.3 && c.north > 21.3 && c.west < -157.9 && c.east > -157.9);
  assert.throws(() => resolveRegionBounds({ preset: 'atlantis' }), /unknown region preset/);
  assert.throws(() => resolveRegionBounds({ bounds: { west: 0, south: 5, east: 1, north: 1 } }), /invalid/);
  assert.throws(() => resolveRegionBounds({ center: { latitude: 0, longitude: 0 }, radiusM: 0 }), /radiusM/);
});

test('builder: a provider whose policy forbids packing is refused with a clear error and nothing is written', async () => {
  const dir = await tempDir();
  const pm = await writeTemp(dir, 'hawaii.pmtiles', pmtilesStub());
  const builder = new WorldPackBuilder();
  const attempt = async (policy: ProviderDataPolicy | undefined, pattern: RegExp) => {
    const req = baseRequest(dir, {
      include: ['map', 'places'],
      sources: { pmtilesPath: pm, placesGeoJsonPath: PLACES },
      policies: policies(policy ? { 'protomaps-builds': policy } : {}),
    });
    if (!policy) req.policies = (id) => (id === 'protomaps-builds' ? undefined : policies()(id));
    await assert.rejects(
      builder.build(req),
      (err: unknown) =>
        err instanceof WorldPackBuildError && err.code === 'POLICY_REFUSED' && pattern.test(err.message),
      `expected ${pattern}`,
    );
    await assert.rejects(fs.stat(req.outputPath), /ENOENT/);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.partial'));
    assert.deepEqual(leftovers, []);
  };
  await attempt(NO_PACK_POLICY, /protomaps-builds.*offlinePackAllowed=false/);
  await attempt(NO_REDIST_POLICY, /protomaps-builds.*redistributionAllowed=false/);
  await attempt(undefined, /no data policy is registered/);
  const { attributionText: _dropped, ...withoutAttribution } = PROTOMAPS_POLICY;
  void _dropped;
  await attempt(withoutAttribution, /attribution is required/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('builder: missing or invalid sources are refused before writing', async () => {
  const dir = await tempDir();
  const builder = new WorldPackBuilder();
  await assert.rejects(
    builder.build(baseRequest(dir, { include: ['map'], sources: {} })),
    (e: WorldPackBuildError) => e.code === 'SOURCE_MISSING',
  );
  await assert.rejects(
    builder.build(baseRequest(dir, { include: ['earthquakes'], sources: {} })),
    (e: WorldPackBuildError) => e.code === 'SOURCE_MISSING',
  );
  const notPm = await writeTemp(dir, 'not.pmtiles', Buffer.from('definitely not pmtiles'));
  await assert.rejects(
    builder.build(baseRequest(dir, { include: ['map'], sources: { pmtilesPath: notPm } })),
    (e: WorldPackBuildError) => e.code === 'INVALID_SOURCE' && /PMTiles v3/.test(e.message),
  );
  const badGeo = await writeTemp(
    dir,
    'bad.geojson',
    Buffer.from(
      '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[999,0]},"properties":{}}]}',
    ),
  );
  await assert.rejects(
    builder.build(baseRequest(dir, { include: ['places'], sources: { placesGeoJsonPath: badGeo } })),
    (e: WorldPackBuildError) => e.code === 'INVALID_SOURCE',
  );
  await assert.rejects(
    builder.build(baseRequest(dir, { id: 'Bad Id' })),
    (e: WorldPackBuildError) => e.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    builder.build(baseRequest(dir, { include: [] })),
    (e: WorldPackBuildError) => e.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    builder.build(baseRequest(dir, { outputPath: path.join(dir, 'x.zip') })),
    (e: WorldPackBuildError) => e.code === 'INVALID_REQUEST',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('builder: Hawaii pack from the seed fixtures — clipped layers, search index, NOTICES, checksums, report', async () => {
  const dir = await tempDir();
  const pm = await writeTemp(dir, 'hawaii-basemap.pmtiles', pmtilesStub());
  const clock = new VirtualClock(Date.parse('2026-09-21T12:00:00Z'));
  const history = await seededHistory(path.join(dir, 'data'), clock, policies());
  const builder = new WorldPackBuilder();
  const req = baseRequest(dir, {
    include: ['map', 'places', 'airports', 'earthquakes'],
    version: '1.0.0',
    clock,
    sources: {
      pmtilesPath: pm,
      placesGeoJsonPath: PLACES,
      airportsGeoJsonPath: AIRPORTS,
      history: history.store,
      earthquakeWindowDays: 30,
    },
  });
  const report = await builder.build(req);
  await history.store.close();

  assert.equal(report.ok, true);
  assert.equal(report.layers.map?.sourcePath, pm);
  assert.ok(
    report.layers.places!.kept >= 20 && report.layers.places!.kept < 40,
    `places kept ${report.layers.places!.kept}`,
  );
  assert.ok(report.layers.places!.dropped > 100);
  assert.equal(report.layers.airports!.kept, 5, 'HNL OGG KOA ITO LIH');
  assert.equal(report.layers.earthquakes!.rows, history.inside, 'only quakes inside the bounds');
  assert.deepEqual(report.layers.earthquakes!.providers, [USGS]);
  assert.ok(report.searchIndexEntries >= 25);
  assert.deepEqual(
    report.entries.map((e) => e.path),
    [
      'maps/hawaii-basemap.pmtiles',
      'data/places.geojson',
      'data/airports.geojson',
      'data/earthquakes.ndjson',
      'search/index.json',
      'licenses/NOTICES.md',
    ],
  );
  assert.deepEqual(
    report.sources.map((s) => s.providerId).sort(),
    ['protomaps-builds', USGS, SEED_AIRPORTS_PROVIDER_ID, SEED_PLACES_PROVIDER_ID].sort(),
  );
  assert.deepEqual(report.warnings, []);
  const written = JSON.parse(await fs.readFile(report.reportPath, 'utf8')) as { id: string };
  assert.equal(written.id, 'hawaii-test');

  const verification = await verifyWorldPack(req.outputPath, { appVersion: '0.1.0' });
  assert.equal(verification.ok, true, verification.issues.join('; '));
  const manifest = verification.manifest!;
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.createdAt, '2026-09-21T12:00:00.000Z');
  assert.equal(
    manifest.sourcePolicies.find((p) => p.providerId === 'protomaps-builds')?.attribution,
    PROTOMAPS_POLICY.attributionText,
  );
  assert.equal(
    manifest.sourcePolicies.find((p) => p.providerId === USGS)?.license,
    'U.S. Government work — public domain',
  );
  assert.ok(manifest.contents.every((c) => manifest.checksums[c.path] === c.sha256));

  const reader = await ZipReader.open(req.outputPath);
  const notices = (await reader.readEntry('licenses/NOTICES.md')).toString('utf8');
  assert.match(notices, /Protomaps · © OpenStreetMap contributors \(ODbL\)/);
  assert.match(notices, /Data courtesy of the U\.S\. Geological Survey/);
  assert.match(notices, /data\/earthquakes\.ndjson.*\(5 rows\)/);
  const indexJson = JSON.parse((await reader.readEntry('search/index.json')).toString('utf8'));
  const ix = PlaceIndex.fromJSON(indexJson);
  assert.ok(ix.ok);
  if (ix.ok) {
    assert.equal(ix.index.search('Honolulu')[0]?.entry.name, 'Honolulu');
    assert.equal(ix.index.search('HNL')[0]?.entry.icao, 'PHNL');
    assert.equal(ix.index.search('Tokyo').length, 0, 'clipped to Hawaii');
  }
  const quakes = (await reader.readEntry('data/earthquakes.ndjson')).toString('utf8').trim().split('\n');
  assert.equal(quakes.length, history.inside);
  assert.ok(quakes.every((l) => (JSON.parse(l) as { providerId: string }).providerId === USGS));
  assert.equal(reader.entry('maps/hawaii-basemap.pmtiles')?.method, 0, 'PMTiles are stored, not deflated');
  await reader.close();

  // Deterministic: the same request yields byte-identical output.
  const again = baseRequest(dir, {
    ...req,
    outputPath: path.join(dir, 'again.worldpack'),
    clock: new VirtualClock(Date.parse('2026-09-21T12:00:00Z')),
    include: ['map', 'places', 'airports'],
    sources: { pmtilesPath: pm, placesGeoJsonPath: PLACES, airportsGeoJsonPath: AIRPORTS },
  });
  const first = baseRequest(dir, {
    ...again,
    outputPath: path.join(dir, 'first.worldpack'),
    clock: new VirtualClock(Date.parse('2026-09-21T12:00:00Z')),
  });
  await builder.build(first);
  await builder.build(again);
  assert.ok((await fs.readFile(first.outputPath)).equals(await fs.readFile(again.outputPath)));
  const inspected = await readWorldPackManifest(again.outputPath);
  assert.ok(inspected.ok && inspected.manifest.id === 'hawaii-test');
  await fs.rm(dir, { recursive: true, force: true });
});

test('builder: an empty region still builds but warns, and a circle region clips', async () => {
  const dir = await tempDir();
  const builder = new WorldPackBuilder();
  const report = await builder.build(
    baseRequest(dir, { region: { bounds: { west: 0, south: -1, east: 1, north: 0 } } }),
  );
  assert.ok(report.warnings.some((w) => /places layer is empty/.test(w)));
  assert.ok(report.warnings.some((w) => /search index is empty/.test(w)));
  assert.ok(!report.entries.some((e) => e.path === 'search/index.json'));
  const circle = await builder.build(
    baseRequest(dir, {
      outputPath: path.join(dir, 'circle.worldpack'),
      region: { center: { latitude: 21.31, longitude: -157.86 }, radiusM: 60_000 },
    }),
  );
  assert.ok(circle.layers.places!.kept >= 5 && circle.layers.places!.kept <= 15, `kept ${circle.layers.places!.kept}`);
  assert.equal(circle.layers.airports!.kept, 1, 'HNL only');
  await fs.rm(dir, { recursive: true, force: true });
});

test('builder: a pack built with a signing key carries manifest.sig over the manifest it wrote', async () => {
  const dir = await tempDir();
  const key = generatePackKeyPair();
  const report = await new WorldPackBuilder().build(baseRequest(dir, { signingKeyPem: key.privateKeyPem }));
  assert.equal(report.signedBy, key.keyId);
  assert.equal(JSON.stringify(report).includes('PRIVATE KEY'), false, 'the key never reaches the report');
  const v = await verifyWorldPack(report.outputPath);
  assert.ok(v.ok, v.issues.join('; '));
  assert.ok(v.signature?.status === 'signed' && v.signature.keyId === key.keyId);
  assert.equal(
    report.entries.some((e) => e.path === 'manifest.sig'),
    false,
    'the signature is not a manifest entry',
  );
  await assert.rejects(
    new WorldPackBuilder().build(
      baseRequest(dir, { signingKeyPem: 'not a key', outputPath: path.join(dir, 'bad.worldpack') }),
    ),
    (err: unknown) => err instanceof WorldPackBuildError && /signing key unusable/.test(err.message),
  );
  await assert.rejects(fs.stat(path.join(dir, 'bad.worldpack')), /ENOENT/, 'nothing written for a bad key');
  await fs.rm(dir, { recursive: true, force: true });
});
