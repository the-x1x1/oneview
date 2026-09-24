import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildObservation, testing, type WorldProvider } from '@worldview/provider-sdk';
import { geometryCentroid, type JsonValue, type Observation, type WorldGeometry } from '@worldview/world-model';
import {
  compileMapping,
  definitionToManifest,
  mapRecord,
  parseDefinition,
  readPosition,
  resolveTransform,
  type ConnectorProviderDefinition,
  type MappingSpec,
} from '@worldview/connector-sdk';
import {
  defaultConnectorRegistry,
  formatSuite,
  runConnectorSuite,
  RestJsonProvider,
} from '@worldview/connector-runtime';
import { substitutePathCredential } from '@worldview/core';
import { defaultIdentityResolver } from '@worldview/identity';
import { loadSidecar, sidecarPathFor } from '@worldview/tool-connector-validator';
import { findDefinitions } from '@worldview/tool-license-audit';
import { normalizeUsgsFeed, USGS_MANIFEST } from '@worldview/provider-usgs';
import { normalizeCurrentStorms } from '@worldview/provider-nhc';
import { normalizeNwsAlerts } from '@worldview/provider-weather';
import { AISSTREAM_MANIFEST, normalizeAisEnvelope } from '@worldview/provider-ais';
import { ADSB_LOL_MANIFEST, normalizeAircraftRows, parseAdsbLolResponse } from '@worldview/provider-adsb-remote';
import { detectionExternalId, isKeyRejection, parseFirmsCsv } from '@worldview/provider-firms';
import { normalizeAirportCollection, SEED_AIRPORTS_MANIFEST } from '@worldview/provider-infrastructure';

/**
 * Phase provider-migration: the evidence behind docs/providers/MIGRATION-MATRIX.md.
 *
 * Every definition this phase wrote (connectors/enabled/pending-review until reviewed,
 * connectors/examples/migrated) runs the shared connector suite from its sidecar, and is then compared with the bespoke
 * provider's own normalizer on the provider's own fixtures: external ids, positions, payload keys
 * and values. Where a definition cannot match, the difference is asserted exactly and named as a
 * known gap. A known gap is a claim in the matrix; when an amendment closes one, the assertion here
 * fails, and the matrix row (and perhaps the classification) is updated with it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel: string): unknown => JSON.parse(read(rel));

const SHIPPED_DIR = 'connectors/enabled';
const PENDING_DIR = 'connectors/enabled/pending-review';
const MIGRATED_DIR = 'connectors/examples/migrated';

/** The definitions this phase wrote. The MIGRATE set moves from PENDING_DIR up to SHIPPED_DIR when reviewed. */
const PHASE_DEFINITIONS = ['usgs-earthquakes-feed', 'adsb-lol-fixed-point', 'aisstream-feed', 'nhc-storms-feed'];

/** Where a definition is now: shipped (reviewed), pending review, or an example. */
function locate(name: string): string {
  for (const dir of [SHIPPED_DIR, PENDING_DIR, MIGRATED_DIR]) {
    const rel = `${dir}/${name}.json`;
    if (existsSync(path.join(root, rel))) return rel;
  }
  throw new Error(`definition ${name} not found`);
}

/** Definitions in a directory; none when it does not exist (git keeps no empty pending-review/). */
function definitionFiles(dir: string): string[] {
  if (!existsSync(path.join(root, dir))) return [];
  return readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'))
    .sort()
    .map((f) => `${dir}/${f}`);
}

function definition(rel: string, overrides: Partial<ConnectorProviderDefinition> = {}): ConnectorProviderDefinition {
  const parsed = parseDefinition({ ...(readJson(rel) as object), ...overrides });
  assert.ok(parsed.ok, `${rel}: ${parsed.ok ? '' : parsed.issues.join('; ')}`);
  return parsed.definition;
}

/** One poll of a definition's provider over a fixture body, as the provider host would run it. */
async function poll(def: ConnectorProviderDefinition, body: string, nowIso: string): Promise<Observation[]> {
  const provider = defaultConnectorRegistry.createProvider(def);
  const ctx = testing.createFixtureContext({
    providerId: def.id,
    clock: new testing.VirtualClock(Date.parse(nowIso)),
    responder: () => ({ status: 200, body }),
  });
  await provider.initialize(ctx);
  await provider.start();
  return provider.query!({ signal: new AbortController().signal, background: true });
}

/** Messages through a definition's socket; returns what it emitted and its health afterwards. */
async function listen(
  def: ConnectorProviderDefinition,
  messages: string[],
  nowIso: string,
): Promise<{ observations: Observation[]; provider: WorldProvider }> {
  const sockets = new testing.FixtureSockets();
  const provider = defaultConnectorRegistry.createProvider(def);
  const ctx = testing.createFixtureContext({
    providerId: def.id,
    clock: new testing.VirtualClock(Date.parse(nowIso)),
    credentials: Object.values(def.credentials ?? {}).map((c) => c.secretRef),
    sockets,
  });
  await provider.initialize(ctx);
  await provider.start();
  const observations: Observation[] = [];
  const abort = new AbortController();
  await provider.subscribe!({ signal: abort.signal }, (obs) => observations.push(...obs));
  const handle = sockets.opened[0]!.handle;
  handle.simulateOpen({ secret: 'test-secret' });
  for (const m of messages) handle.simulateMessage(m);
  await new Promise((r) => setTimeout(r, (def.websocket?.flushMs ?? 500) + 50));
  abort.abort();
  return { observations, provider };
}

const byId = (obs: Observation[]): Map<string, Observation> => new Map(obs.map((o) => [o.externalId!, o]));
const ids = (obs: Observation[]): string[] => obs.map((o) => o.externalId!).sort();
const keys = (o: Observation): string[] => Object.keys(o.payload).sort();
const without = (list: string[], drop: string[]): string[] => list.filter((k) => !drop.includes(k));

/** Same external id → same observedAt, latitude, longitude, altitudeM and payload values for shared keys. */
function assertSameObservation(bespoke: Observation, def: Observation): void {
  const id = bespoke.externalId;
  assert.equal(def.observedAt, bespoke.observedAt, `${id}: observedAt`);
  assert.equal(def.position?.latitude, bespoke.position?.latitude, `${id}: latitude`);
  assert.equal(def.position?.longitude, bespoke.position?.longitude, `${id}: longitude`);
  assert.equal(def.position?.altitudeM, bespoke.position?.altitudeM, `${id}: altitudeM`);
  for (const k of Object.keys(def.payload))
    if (k in bespoke.payload) assert.deepEqual(def.payload[k], bespoke.payload[k], `${id}: payload.${k}`);
}

// ── the shared suite, from each sidecar ─────────────────────────────────────

test('every migrated definition and hybrid example passes the shared connector suite from its sidecar', async () => {
  assert.deepEqual(
    [...definitionFiles(PENDING_DIR), ...definitionFiles(MIGRATED_DIR)].filter(
      (rel) => !PHASE_DEFINITIONS.includes(path.basename(rel, '.json')),
    ),
    [],
    'every definition in these directories is tested here',
  );
  for (const name of PHASE_DEFINITIONS) {
    const rel = locate(name);
    const result = await runConnectorSuite(readJson(rel), loadSidecar(sidecarPathFor(path.join(root, rel)), root));
    assert.ok(result.passed, formatSuite(result));
  }
});

test('until reviewed, every definition is user-configured, disabled, opens no data policy and is not shipped', () => {
  const shipped = findDefinitions(root).map((abs) => path.relative(root, abs).split(path.sep).join('/'));
  for (const name of PHASE_DEFINITIONS) {
    const rel = locate(name);
    if (rel.startsWith(`${SHIPPED_DIR}/${name}`)) continue; // reviewed: the licence audit governs it now
    const doc = readJson(rel) as Record<string, unknown>;
    assert.equal(doc['review'], 'user-configured', rel);
    assert.equal(doc['enabled'], false, rel);
    assert.equal(doc['dataPolicy'], undefined, rel);
    assert.ok(!shipped.includes(rel), `${rel} is read as a shipped definition`);
  }
});

// ── MIGRATE: usgs-earthquakes ───────────────────────────────────────────────

const USGS_NOW = '2026-09-21T08:00:00.000Z';
const USGS_DEF = locate('usgs-earthquakes-feed');
/** Payload keys the bespoke provider writes that the definition cannot (matrix: usgs-earthquakes). */
const USGS_KEY_GAPS = ['aliases'];

for (const fixture of ['fixtures/usgs/normal.geojson', 'fixtures/usgs/stale.geojson']) {
  test(`usgs-earthquakes: the definition matches the bespoke normalizer on ${fixture}`, async () => {
    const bespoke = normalizeUsgsFeed(readJson(fixture), { receivedAt: USGS_NOW }).observations;
    const def = await poll(definition(USGS_DEF), read(fixture), USGS_NOW);
    assert.ok(bespoke.length > 0);
    assert.deepEqual(ids(def), ids(bespoke));
    const mine = byId(def);
    for (const b of bespoke) {
      const d = mine.get(b.externalId!)!;
      assertSameObservation(b, d);
      assert.deepEqual(keys(d), without(keys(b), USGS_KEY_GAPS), `${b.externalId}: payload keys`);
      assert.equal(d.provenance.attribution, b.provenance.attribution);
      assert.equal(d.quality.sourceQuality, b.quality.sourceQuality);
    }
  });
}

test('usgs-earthquakes known gaps: aliases, quality flags and the altitude datum are not carried', async () => {
  const fixture = 'fixtures/usgs/normal.geojson';
  const bespoke = byId(normalizeUsgsFeed(readJson(fixture), { receivedAt: USGS_NOW }).observations);
  const def = byId(await poll(definition(USGS_DEF), read(fixture), USGS_NOW));
  // `ids` is a comma-separated string; the mapping has no split transform.
  assert.deepEqual(bespoke.get('us7000wv01')!.payload['aliases'], ['us7000wv01']);
  assert.equal(def.get('us7000wv01')!.payload['aliases'], undefined);
  // The provider flags automatic solutions and non-earthquake events; a mapping cannot set flags.
  assert.deepEqual(bespoke.get('ci40912345')!.quality.flags, ['automatic']);
  assert.deepEqual(bespoke.get('nc75012345')!.quality.flags, ['event-type:quarry blast']);
  assert.equal(def.get('ci40912345')!.quality.flags, undefined);
  assert.equal(def.get('nc75012345')!.quality.flags, undefined);
  // Depth as altitude: same metres, but the datum ('msl') is not settable from a mapping.
  assert.equal(bespoke.get('us7000wv01')!.position!.altitudeDatum, 'msl');
  assert.equal(def.get('us7000wv01')!.position!.altitudeDatum, undefined);
});

test('usgs-earthquakes known gap: a non-numeric magnitude drops the field, not the event', async () => {
  const fixture = 'fixtures/usgs/malformed-rows.geojson';
  const bespoke = normalizeUsgsFeed(readJson(fixture), { receivedAt: USGS_NOW }).observations;
  const def = await poll(definition(USGS_DEF), read(fixture), USGS_NOW);
  assert.deepEqual(ids(bespoke), ['ci40912345']);
  assert.deepEqual(ids(def), ['ci40912345', 'hv74012345']);
  assert.equal(byId(def).get('hv74012345')!.payload['magnitude'], undefined);
});

test('usgs-earthquakes: which malformed rows each side refuses (a definition is more lenient)', async () => {
  const base = (readJson('fixtures/usgs/normal.geojson') as { features: Array<Record<string, unknown>> }).features[0]!;
  const variant = (id: string, props: Record<string, unknown>, geometry?: unknown) => ({
    ...base,
    id,
    properties: { ...(base['properties'] as object), ...props },
    ...(geometry !== undefined ? { geometry } : {}),
  });
  const body = {
    type: 'FeatureCollection',
    features: [
      variant('badtime', { time: 'yesterday' }),
      variant('baddepth', {}, { type: 'Point', coordinates: [152.8, -5.2, 'deep'] }),
      variant('bigmag', { mag: 12 }),
      variant('oddmagtype', { magType: 'xyz' }),
      variant(
        'line',
        {},
        {
          type: 'LineString',
          coordinates: [
            [152.8, -5.2],
            [152.9, -5.3],
          ],
        },
      ),
    ],
  };
  const bespoke = normalizeUsgsFeed(body, { receivedAt: USGS_NOW });
  const def = byId(await poll(definition(USGS_DEF), JSON.stringify(body), USGS_NOW));
  assert.deepEqual(ids(bespoke.observations), ['oddmagtype']);
  assert.deepEqual(
    bespoke.rejected.map((r) => r.reason),
    ['invalid time', 'invalid depth', 'invalid magnitude', 'missing point geometry'],
  );
  // Both refuse an unreadable time (observedAt is required) and a non-point geometry.
  assert.ok(!def.has('badtime') && !def.has('line'));
  // Known gaps: the definition keeps a non-numeric depth (without depth or altitude), a magnitude
  // outside −5…10, and a magnitude type outside USGS's list, where the provider refuses or drops them.
  assert.deepEqual([...def.keys()].sort(), ['baddepth', 'bigmag', 'oddmagtype']);
  assert.equal(def.get('baddepth')!.payload['depthKm'], undefined);
  assert.equal(def.get('bigmag')!.payload['magnitude'], 12);
  assert.equal(def.get('oddmagtype')!.payload['magType'], 'xyz');
  assert.equal(bespoke.observations[0]!.payload['magType'], undefined);
});

test('usgs-earthquakes: a reviewed definition may set no retention cap, as the provider does (A8 landed)', () => {
  // Registry step 2 in the matrix: `bundled`, and the policy the usgs-earthquakes record grants.
  const opened = {
    rawPayloadRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
  } as const;
  const flipped = definition(USGS_DEF, { review: 'bundled', dataPolicy: { ...opened, maxRetentionSeconds: null } });
  const policy = definitionToManifest(flipped, 'GeoJSON').dataPolicy;
  for (const key of [
    'cacheAllowed',
    'rawPayloadRetentionAllowed',
    'normalizedRetentionAllowed',
    'redistributionAllowed',
    'offlinePackAllowed',
    'exportAllowed',
    'commercialUseAllowed',
    'attributionRequired',
  ] as const)
    assert.equal(policy[key], USGS_MANIFEST.dataPolicy[key], key);
  // The provider sets no cap (earthquakes are kept indefinitely); `null` says the same in a definition.
  assert.equal(USGS_MANIFEST.dataPolicy.maxRetentionSeconds, undefined);
  assert.equal(policy.maxRetentionSeconds, undefined);
  assert.ok(!('maxRetentionSeconds' in policy), 'the field is left out, not set to null');
  // Without it the seven-day default stands, and an unreviewed file may not lift it.
  assert.equal(
    definitionToManifest(definition(USGS_DEF, { review: 'bundled' }), 'GeoJSON').dataPolicy.maxRetentionSeconds,
    7 * 86_400,
  );
  const unreviewed = parseDefinition({ ...(readJson(USGS_DEF) as object), dataPolicy: { maxRetentionSeconds: null } });
  assert.ok(!unreviewed.ok && unreviewed.issues.join(' ').includes('maxRetentionSeconds'));
});

test('usgs-earthquakes: object identity is the same only under the bespoke provider id', async () => {
  const fixture = 'fixtures/usgs/normal.geojson';
  const bespoke = normalizeUsgsFeed(readJson(fixture), { receivedAt: USGS_NOW }).observations;
  const objectIds = (obs: Observation[]) => obs.map((o) => defaultIdentityResolver.resolve(o).objectId).sort();
  // Under its own id (required while the bespoke provider is registered) the definition's
  // earthquakes are provider-scoped objects: the USGS identity rule is keyed on the provider id.
  const asFiled = await poll(definition(USGS_DEF), read(fixture), USGS_NOW);
  assert.ok(asFiled.every((o) => !defaultIdentityResolver.resolve(o).authoritative));
  assert.notDeepEqual(objectIds(asFiled), objectIds(bespoke));
  // Given the bespoke id when the bespoke provider is retired, every object id is the same.
  const renamed = await poll(definition(USGS_DEF, { id: 'usgs-earthquakes' }), read(fixture), USGS_NOW);
  assert.ok(renamed.every((o) => defaultIdentityResolver.resolve(o).authoritative));
  assert.deepEqual(objectIds(renamed), objectIds(bespoke));
});

// ── HYBRID: nhc-storms ──────────────────────────────────────────────────────

const NHC_NOW = '2026-09-23T04:00:00.000Z';
const NHC_DEF = locate('nhc-storms-feed');

test('nhc-storms: ids, positions, times and shared values match; the storm-id check and four keys do not', async () => {
  const fixture = 'fixtures/nhc/normal.json';
  const bespoke = normalizeCurrentStorms(readJson(fixture), { receivedAt: NHC_NOW, nowMs: Date.parse(NHC_NOW) });
  const def = await poll(definition(NHC_DEF), read(fixture), NHC_NOW);
  assert.deepEqual(ids(bespoke.observations), ['al092026', 'ep162026']);
  // Known gap: `zz012026` is not an NHC storm id (basin + number + year); a mapping has no pattern check.
  assert.deepEqual(ids(def), ['al092026', 'ep162026', 'zz012026']);
  const mine = byId(def);
  const gaps: Record<string, string[]> = {
    // Basin and label are lookups on the id prefix and the classification code; the links are
    // kept only on www.nhc.noaa.gov (the Sample storm's graphics link is on another host).
    ep162026: ['advisoryUrl', 'basin', 'classificationLabel', 'graphicsUrl'],
    al092026: ['advisoryUrl', 'basin', 'classificationLabel'],
  };
  for (const b of bespoke.observations) {
    const d = mine.get(b.externalId!)!;
    assertSameObservation(b, d);
    assert.deepEqual(keys(d), without(keys(b), gaps[b.externalId!]!), `${b.externalId}: payload keys`);
  }
  assert.equal(
    bespoke.observations.find((o) => o.externalId === 'ep162026')!.payload['classificationLabel'],
    'Tropical Storm',
  );
});

// ── HYBRID: nws-alerts (no definition possible yet) ─────────────────────────

test('nws-alerts: every alert id is a URN with colons, which a mapping now accepts as an external id (A2 landed)', () => {
  const doc = readJson('fixtures/weather/normal.geojson') as { features: Array<Record<string, unknown>> };
  const now = Date.parse('2026-09-21T08:00:00.000Z');
  const bespoke = normalizeNwsAlerts(doc, { receivedAt: new Date(now).toISOString(), nowMs: now });
  assert.equal(bespoke.observations.length, 7, 'the provider admits the seven polygon alerts');
  const m = compileMapping({ externalId: 'properties.id', position: { geometry: 'geometry' } });
  const mapped = doc.features.map((f) => mapRecord(f, m));
  assert.equal(mapped.filter((r) => r.ok).length, 9, 'every alert maps by its URN');
  for (const r of mapped) if (r.ok) assert.match(r.record.externalId, /^urn:oid:2\.49\.0\.1\.840\.0\./);
  assert.equal(mapped.filter((r) => r.ok && r.record.position).length, 7, 'the seven polygon alerts have a position');
  // The feature id is the alert's URL, which carries colons too.
  const byUrl = compileMapping({ externalId: 'id', position: { geometry: 'geometry' } });
  assert.equal(doc.features.filter((f) => mapRecord(f, byUrl).ok).length, 9);
  // Blank and whitespace are still refused: the identity resolver encodes the rest.
  const blank = mapRecord({ properties: { id: 'a b' }, geometry: doc.features[0]!['geometry'] }, m);
  assert.ok(!blank.ok && !('skipped' in blank) && /is not usable/.test(blank.reason));
});

test("nws-alerts: a polygon's representative point is its first vertex in a mapping, its centroid in the provider", () => {
  const doc = readJson('fixtures/weather/normal.geojson') as { features: Array<Record<string, unknown>> };
  const position = compileMapping({ externalId: 'properties.event', position: { geometry: 'geometry' } }).position!;
  let polygons = 0;
  for (const f of doc.features) {
    const g = f['geometry'] as WorldGeometry | null;
    if (!g) continue;
    polygons++;
    const first = readPosition(f, position)!;
    const centroid = geometryCentroid(g)!;
    assert.ok(
      Math.abs(first.latitude - centroid.latitude) + Math.abs(first.longitude - centroid.longitude) > 0.01,
      `${String((f['properties'] as Record<string, unknown>)['event'])}: first vertex equals centroid`,
    );
  }
  assert.equal(polygons, 7);
});

// ── HYBRID: aisstream-io ────────────────────────────────────────────────────

const AIS_NOW = '2026-09-21T08:00:10.000Z';
const AIS_DEF = locate('aisstream-feed');
const AIS_FRAMES = [
  '01-position-report.json',
  '02-position-heading-511.json',
  '03-position-anchored.json',
  '04-ship-static-data.json',
  '05-malformed.json',
  '06-out-of-bounds.json',
].map((f) => read(`fixtures/aisstream/frames/${f}`));

/**
 * Payload keys the provider writes that the example leaves out: motion (sentinels), the status and
 * type texts (lookups), rate of turn (a non-linear formula), length, beam and ETA (several fields each).
 */
const AIS_KEY_GAPS = [
  'beamM',
  'courseDegrees',
  'eta',
  'headingDegrees',
  'lengthM',
  'navStatusText',
  'rateOfTurnDegPerMin',
  'shipTypeText',
  'speedMps',
];

function aisBespoke(frames: string[]): Observation[] {
  const out: Observation[] = [];
  for (const frame of frames) {
    const r = normalizeAisEnvelope(JSON.parse(frame), { receivedAt: AIS_NOW });
    if (r.kind === 'observation') out.push(buildObservation(AISSTREAM_MANIFEST, AIS_NOW, r.draft));
  }
  return out;
}

test('aisstream-io: positions, times and names match; short MMSIs are not padded and lose vessel identity', async () => {
  const bespoke = aisBespoke(AIS_FRAMES);
  const { observations } = await listen(definition(AIS_DEF), AIS_FRAMES, AIS_NOW);
  assert.deepEqual(ids(bespoke), ['002320001', '338987654', '366123456', '366123456', '431009876']);
  // Known gaps: no zero-padding transform; and within one batch the newest record for an id wins,
  // so MMSI 366123456's static-data frame replaces its position report.
  assert.deepEqual(ids(observations), ['2320001', '338987654', '366123456', '431009876']);
  const mine = byId(observations);
  // The position reports, and the static-data report that won MMSI 366123456's batch.
  const compared = bespoke.filter(
    (b) => b.externalId !== '002320001' && (b.externalId !== '366123456' || b.quality.flags?.includes('static-data')),
  );
  assert.equal(compared.length, 3);
  for (const b of compared) {
    const d = mine.get(b.externalId!)!;
    assertSameObservation(b, d);
    assert.ok(
      Object.keys(d.payload).every((k) => k in b.payload),
      `${b.externalId}: a key the provider lacks`,
    );
    const missing = keys(b).filter((k) => !(k in d.payload));
    assert.ok(
      missing.every((k) => AIS_KEY_GAPS.includes(k)),
      `${b.externalId}: missing ${missing.join(', ')}`,
    );
    // Known gap: the provider places vessels on the sea surface; a mapping cannot set the datum.
    assert.equal(b.position!.altitudeDatum, 'sea-surface');
    assert.equal(d.position!.altitudeDatum, undefined);
  }
  const padded = bespoke.find((o) => o.externalId === '002320001')!;
  const unpadded = mine.get('2320001')!;
  assert.equal(defaultIdentityResolver.resolve(padded).rule, 'vessel.mmsi');
  assert.equal(defaultIdentityResolver.resolve(unpadded).rule, 'provider-scoped');
});

test('aisstream-io: why motion is left out of the example — the mapping would show "not available" as a value', () => {
  const m = compileMapping({
    externalId: { path: 'MetaData.MMSI', transform: 'string' },
    motion: {
      headingDegrees: { path: 'Message.PositionReport.TrueHeading', transform: 'headingDegrees' },
      speedMps: { path: 'Message.PositionReport.Sog', transform: 'knotsToMps' },
    },
    properties: { courseDegrees: { path: 'Message.PositionReport.Cog', transform: 'headingDegrees' } },
  } satisfies MappingSpec);
  const frame = (i: number): unknown => JSON.parse(AIS_FRAMES[i]!);
  const mapped = (i: number): Record<string, JsonValue> => {
    const r = mapRecord(frame(i), m);
    assert.ok(r.ok);
    return r.record.properties;
  };
  const provider = (i: number): Record<string, JsonValue> => aisBespoke([AIS_FRAMES[i]!])[0]!.payload;
  // TrueHeading 511 = not available: the provider falls back to COG 96.5; the transform says 151°.
  assert.equal(provider(1)['headingDegrees'], 96.5);
  assert.equal(mapped(1)['headingDegrees'], 151);
  // SOG 102.3 kn and COG 360 = not available: the provider drops both; the transforms report 52.6 m/s and 0°.
  assert.equal(provider(2)['speedMps'], undefined);
  assert.equal(provider(2)['courseDegrees'], undefined);
  assert.equal(mapped(2)['speedMps'], 52.628);
  assert.equal(mapped(2)['courseDegrees'], 0);
});

test('aisstream-io: a rejected API key is AUTH in the provider and silence in the definition', async () => {
  const frame = read('fixtures/aisstream/frames/07-auth-error.json');
  const r = normalizeAisEnvelope(JSON.parse(frame), { receivedAt: AIS_NOW });
  assert.equal(r.kind, 'error');
  assert.ok(r.kind === 'error' && r.auth);
  const { observations, provider } = await listen(definition(AIS_DEF), [frame], AIS_NOW);
  assert.equal(observations.length, 0);
  assert.equal((await provider.health()).status, 'LIVE');
});

// ── KEEP (fixed-region hybrid example): adsb-lol ────────────────────────────

const ADSB_NOW = '2026-09-21T08:00:00.000Z';
const ADSB_DEF = locate('adsb-lol-fixed-point');

test('adsb-lol fixed point: ids, positions and motion match; ground, military, time and non-ICAO naming do not', async () => {
  const fixture = 'fixtures/adsb-lol/normal.json';
  const parsed = parseAdsbLolResponse(readJson(fixture));
  assert.ok(typeof parsed !== 'string');
  const bespoke = normalizeAircraftRows(parsed.rows, ADSB_LOL_MANIFEST, {
    nowMs: parsed.nowMs,
    receivedAt: ADSB_NOW,
    sourceQuality: 'crowdsourced',
  }).observations;
  const def = await poll(definition(ADSB_DEF), read(fixture), ADSB_NOW);
  assert.equal(def.length, bespoke.length);
  // Known gap: the provider names a non-ICAO (TIS-B) address `nonicao-…`; a mapping keeps `~…`.
  assert.deepEqual(
    ids(def),
    ids(bespoke).map((id) => (id === 'nonicao-a5b5c5' ? '~a5b5c5' : id)),
  );
  const mine = byId(def);
  for (const b of bespoke) {
    const d = mine.get(b.externalId === 'nonicao-a5b5c5' ? '~a5b5c5' : b.externalId!)!;
    assert.equal(d.position!.latitude, b.position!.latitude);
    assert.equal(d.position!.longitude, b.position!.longitude);
    // Known gap: on the ground the provider says altitude 0 (datum ground); "ground" is not a number.
    if (b.payload['onGround'] === true) assert.equal(d.position!.altitudeM, undefined);
    else assert.equal(d.position!.altitudeM, b.position!.altitudeM, `${b.externalId}: altitudeM`);
    // Known gap: the provider marks the altitude barometric (or ground); a mapping cannot set the datum.
    assert.ok(['barometric', 'ground'].includes(String(b.position!.altitudeDatum)), `${b.externalId}: datum`);
    assert.equal(d.position!.altitudeDatum, undefined);
    for (const k of Object.keys(d.payload))
      if (k in b.payload) assert.deepEqual(d.payload[k], b.payload[k], `${b.externalId}: payload.${k}`);
    // Known gaps: onGround ("ground" as a boolean) and military (a bit of dbFlags) are not expressible.
    const missing = keys(b).filter((k) => !(k in d.payload));
    assert.deepEqual(missing, ['military', 'onGround'], `${b.externalId}: keys the definition lacks`);
    // Known gap: the provider's time is the snapshot's `now` minus `seen_pos`; the definition's is the fetch time.
    assert.deepEqual(d.quality.flags, ['fetch-time']);
    assert.equal(d.observedAt, ADSB_NOW);
    assert.notEqual(b.observedAt, ADSB_NOW);
  }
});

test('transform defect: headingDegrees adds floating-point noise to an in-range heading', () => {
  // ((d % 360) + 360) % 360 is not exact: 92.4 comes back as 92.39999999999998. The examples
  // read headings with `number` instead, which is what the providers do for 0–360 values.
  const heading = resolveTransform('headingDegrees')!;
  assert.notEqual(heading(92.4), 92.4);
  assert.equal(resolveTransform('number')!(92.4), 92.4);
});

// ── HYBRID: nasa-firms (no definition possible yet) ─────────────────────────

test('nasa-firms: a detection id joins four columns with colons; a mapping accepts one (A2) but cannot build it (A4)', () => {
  const csv = parseFirmsCsv(read('fixtures/firms/viirs-snpp.csv'))!;
  const row = csv.rows[0]!;
  const id = detectionExternalId('VIIRS_SNPP_NRT', row);
  assert.equal(id, 'VIIRS_SNPP_NRT:2026-09-21T0742:38.99488:-121.67046');
  const r = mapRecord(
    { latitude: '38.99488', longitude: '-121.67046' },
    compileMapping({ externalId: { literal: id }, position: { lat: 'latitude', lon: 'longitude' } }),
  );
  assert.ok(r.ok && r.record.externalId === id, JSON.stringify(r));
  // Building it from the row's four columns needs `concat` (A4, still open), so FIRMS stays HYBRID.
});

test('nasa-firms: "Invalid MAP_KEY." is AUTH to the provider and an empty, healthy catalogue to the csv connector', async () => {
  const body = read('fixtures/firms/malformed-invalid-key.txt');
  assert.equal(parseFirmsCsv(body), undefined);
  assert.ok(isKeyRejection(body));
  const probe = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'firms-probe',
    name: 'FIRMS csv probe (test only)',
    connector: 'csv',
    objectType: 'fire-detection',
    endpoint: { url: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/VIIRS_SNPP_NRT/world/1' },
    mapping: { externalId: 'acq_date', position: { lat: 'latitude', lon: 'longitude' } },
    attribution: { text: 'NASA FIRMS' },
  });
  assert.ok(probe.ok);
  const provider = defaultConnectorRegistry.createProvider(probe.definition);
  const ctx = testing.createFixtureContext({ providerId: 'firms-probe', responder: () => ({ status: 200, body }) });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query!({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 0);
  assert.equal((await provider.health()).status, 'LIVE');
});

test('nasa-firms: a path credential reaches the request — rest-json keeps {TOKEN} literal for the host to substitute (A1 landed)', () => {
  const parsed = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'firms-path-probe',
    name: 'FIRMS path credential probe (test only)',
    connector: 'csv',
    objectType: 'fire-detection',
    endpoint: {
      url: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{TOKEN}/VIIRS_SNPP_NRT/{west},{south},{east},{north}/1',
      credential: { name: 'mapKey', as: 'path' },
    },
    boundsQuery: true,
    credentials: { mapKey: { secretRef: 'firms.mapKey' } },
    mapping: { externalId: 'acq_date', position: { lat: 'latitude', lon: 'longitude' } },
    attribution: { text: 'NASA FIRMS' },
  });
  assert.ok(parsed.ok, 'the schema accepts the definition');
  const req = new RestJsonProvider(parsed.definition, 'CSV').buildRequest(
    { query: {} },
    { west: -160, south: 18, east: -154, north: 23 },
  );
  assert.equal(
    req.url,
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{TOKEN}/VIIRS_SNPP_NRT/-160.00000,18.00000,-154.00000,23.00000/1',
  );
  assert.equal(
    substitutePathCredential(req.url, 'TOKEN', 'SECRET'),
    'https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRET/VIIRS_SNPP_NRT/-160.00000,18.00000,-154.00000,23.00000/1',
  );
  assert.equal(req.credential?.as, 'path');
});

// ── HYBRID: worldview-seed-airports (transport waits for phase `files`) ──────

/** The mapping a `local-file` definition would carry once phase `files` lands (matrix: airports). */
const AIRPORTS_MAPPING: MappingSpec = {
  externalId: { path: 'properties.icao', transform: 'trim' },
  position: { geometry: 'geometry' },
  labels: { name: { path: 'properties.name', transform: ['trim', 'emptyToNone'] } },
  properties: {
    icao: { path: 'properties.icao', transform: 'trim' },
    iata: { path: 'properties.iata', transform: ['trim', 'uppercase', 'emptyToNone'] },
    type: { path: 'properties.type', transform: ['trim', 'emptyToNone'] },
    municipality: { path: 'properties.municipality', transform: ['trim', 'emptyToNone'] },
    countryCode: { path: 'properties.countryCode', transform: ['trim', 'uppercase', 'emptyToNone'] },
  },
};

test('worldview-seed-airports: the mapping reproduces all 87 airports; the dataset date is not per record', () => {
  const doc = readJson('fixtures/airports/seed-airports.geojson') as { features: unknown[]; datasetDate: string };
  const bespoke = normalizeAirportCollection(doc, SEED_AIRPORTS_MANIFEST, { receivedAt: '2026-09-21T08:00:00.000Z' });
  assert.ok(typeof bespoke !== 'string');
  assert.equal(bespoke.observations.length, 87);
  const m = compileMapping(AIRPORTS_MAPPING);
  const mapped = new Map<string, ReturnType<typeof mapRecord>>();
  for (const f of doc.features) {
    const r = mapRecord(f, m);
    assert.ok(r.ok);
    mapped.set(r.record.externalId, r);
  }
  assert.equal(mapped.size, 87);
  for (const b of bespoke.observations) {
    const r = mapped.get(b.externalId!)!;
    assert.ok(r.ok);
    assert.equal(r.record.position!.latitude, b.position!.latitude);
    assert.equal(r.record.position!.longitude, b.position!.longitude);
    assert.deepEqual({ ...r.record.labels, ...r.record.properties }, b.payload, `${b.externalId}: payload`);
  }
  // Known gap: observedAt is the collection's `datasetDate`, which a per-record mapping cannot read.
  assert.equal(bespoke.observations[0]!.observedAt, new Date(doc.datasetDate).toISOString());
});
