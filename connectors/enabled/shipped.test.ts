import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, type WorldProvider } from '@worldview/provider-sdk';
import { overlayTileTemplate, type Observation, type RasterOverlay, type WorldEvent } from '@worldview/world-model';
import { parseDefinition, type ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { defaultConnectorRegistry, formatSuite, runConnectorSuite } from '@worldview/connector-runtime';
import { loadConnectorDefinitions, providerIds } from '@worldview/providers';
import { BUILT_IN_LENSES, MAP_PROVIDER_CATALOG } from '@worldview/render-core';
import { WorldState } from '@worldview/state-engine';
import { EventEngine, FeedBuilder } from '@worldview/event-engine';
import { loadSidecar, sidecarPathFor } from '@worldview/tool-connector-validator';
import { findDefinitions } from '@worldview/tool-license-audit';

/**
 * The definitions this directory ships (2026-09-27, hazard layers): NOAA nowCOAST radar and
 * GOES infrared overlays, NHC forecast cones and tracks, NIFC wildfire perimeters and six
 * GDACS alert lists. What each one's sidecar cannot say is checked here: how they load in
 * the runtime, what their licence lets them do by default, which Overview layer shows them,
 * that the radar follows its newest frame, and that an area or a line reaches the map with
 * its shape (as a weather-alert event, the path by which both maps draw a hazard's outline).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(root, 'connectors', 'enabled');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const files = findDefinitions(root);
const docOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const byId = new Map(files.map((f) => [String(docOf(f)['id']), f]));

function definition(id: string): ConnectorProviderDefinition {
  const file = byId.get(id);
  assert.ok(file, `${id} is shipped`);
  const parsed = parseDefinition(docOf(file));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.issues.join('; '));
  return parsed.definition;
}

async function started(def: ConnectorProviderDefinition, body: () => string, nowIso: string): Promise<WorldProvider> {
  const provider = defaultConnectorRegistry.createProvider(def);
  const ctx = testing.createFixtureContext({
    providerId: def.id,
    clock: new testing.VirtualClock(Date.parse(nowIso)),
    responder: () => ({ status: 200, body: body() }),
  });
  await provider.initialize(ctx);
  await provider.start();
  return provider;
}

async function poll(def: ConnectorProviderDefinition, body: string, nowIso: string): Promise<Observation[]> {
  const provider = await started(def, () => body, nowIso);
  // The whole world as the view: a viewport source (NIFC) asks for nothing without one.
  const bounds = { west: -180, south: -90, east: 180, north: 90 };
  return provider.query!({ signal: new AbortController().signal, background: true, bounds });
}

const PUBLIC_DOMAIN = [
  'nowcoast-radar',
  'nowcoast-goes-infrared',
  'nhc-forecast-cones',
  'nhc-forecast-tracks',
  'nifc-wildfire-perimeters',
];
const GDACS = [
  'gdacs-earthquakes',
  'gdacs-tropical-cyclones',
  'gdacs-floods',
  'gdacs-volcanoes',
  'gdacs-droughts',
  'gdacs-wildfires',
];

test('the shipped set is the hazard layers, and each passes the shared suite from its sidecar', async () => {
  assert.deepEqual([...byId.keys()].sort(), [...PUBLIC_DOMAIN, ...GDACS].sort());
  for (const file of files) {
    const r = await runConnectorSuite(docOf(file), loadSidecar(sidecarPathFor(file), root), defaultConnectorRegistry);
    assert.ok(r.passed, `${path.basename(file)}\n${formatSuite(r)}`);
  }
});

test('they load as the runtime loads the bundled folder: review kept, no id a built-in provider holds', () => {
  const loaded = loadConnectorDefinitions({ bundledDir: DIR }, providerIds());
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.definitions.length, files.length);
  for (const d of loaded.definitions) assert.notEqual(d.review ?? 'user-configured', 'user-configured', d.id);
  for (const id of byId.keys()) assert.ok(!providerIds().includes(id), `${id} is a built-in provider's id`);
});

test('licence: the public-domain US sources start enabled and open their policy; GDACS is reviewed, off and fails closed', () => {
  for (const id of PUBLIC_DOMAIN) {
    const m = defaultConnectorRegistry.createProvider(definition(id)).manifest;
    assert.equal(m.commercialReview, 'approved', id);
    assert.equal(m.dataPolicy.commercialUseAllowed, true, id);
    assert.equal(m.dataPolicy.redistributionAllowed, true, id);
    assert.equal(m.attribution.licenseId, 'US-PD', id);
    // GOES infrared is off by choice (it covers the map under it), not for its licence.
    assert.equal(m.enabledByDefault, id !== 'nowcoast-goes-infrared', id);
  }
  for (const id of GDACS) {
    const m = defaultConnectorRegistry.createProvider(definition(id)).manifest;
    assert.equal(m.commercialReview, 'conditional', id);
    assert.equal(m.enabledByDefault, false, id);
    assert.equal(m.dataPolicy.commercialUseAllowed, 'unknown', id);
    assert.equal(m.dataPolicy.redistributionAllowed, false, id);
    assert.equal(m.dataPolicy.exportAllowed, false, id);
    assert.equal(m.dataPolicy.offlinePackAllowed, false, id);
    assert.equal(m.dataPolicy.rawPayloadRetentionAllowed, false, id);
    assert.equal(m.dataPolicy.attributionRequired, true, id);
    assert.equal(m.attribution.text, 'Global Disaster Awareness and Coordination System, GDACS', id);
    assert.deepEqual(m.allowedHosts, ['www.gdacs.org'], id);
  }
});

test('Overview: each is filed under the Weather or Disasters layer, and that layer shows its object type', () => {
  const lenses = new Map(BUILT_IN_LENSES.map((l) => [l.id, l]));
  for (const id of byId.keys()) {
    const d = definition(id);
    assert.ok(d.categories?.length, id);
    for (const c of d.categories!) {
      assert.ok(c === 'weather' || c === 'disasters', `${id}: ${c}`);
      // An overlay is not an object: its switch is the source itself. The rest must be drawn by their layer.
      if (d.connector !== 'wms') assert.ok(lenses.get(c)!.objectTypes.includes(d.objectType), `${id} in ${c}`);
    }
  }
  assert.deepEqual(definition('nowcoast-radar').categories, ['weather']);
  assert.deepEqual(definition('nifc-wildfire-perimeters').categories, ['disasters']);
});

test('nowCOAST radar: the newest frame is the TIME of every tile, a new frame republishes, and no tile cache holds it', async () => {
  let body = read('fixtures/connectors/hazards/nowcoast-radar-wms130-capabilities.xml');
  const provider = await started(definition('nowcoast-radar'), () => body, '2026-09-27T21:40:00.000Z');
  const [first] = (await provider.overlays!()) as RasterOverlay[];
  assert.ok(first && first.kind === 'wms');
  assert.equal(first.url, 'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms');
  assert.equal(first.layers, 'conus_base_reflectivity_mosaic');
  assert.equal(first.styles, 'weather_radar_base_reflectivity');
  assert.equal(first.parameters?.['TIME'], '2026-09-27T21:36:00.000Z');
  assert.equal(first.role, 'overlay');
  assert.deepEqual(first.bounds, { west: -126, south: 20, east: -66, north: 50 });
  assert.match(
    overlayTileTemplate(first)!,
    /LAYERS=conus_base_reflectivity_mosaic&.*CRS=EPSG%3A3857.*&TIME=2026-09-27T21%3A36%3A00.000Z&BBOX=/,
  );
  body = read('fixtures/connectors/hazards/nowcoast-radar-wms130-capabilities-next.xml');
  await provider.query!({ signal: new AbortController().signal, background: true });
  const [second] = (await provider.overlays!()) as RasterOverlay[];
  assert.equal(second!.kind === 'wms' && second!.parameters?.['TIME'], '2026-09-27T21:40:00.000Z');
  assert.notEqual(JSON.stringify(second), JSON.stringify(first));
  assert.equal(first.id, 'nowcoast-radar:conus_base_reflectivity_mosaic:2026-09-27t21-36-00.000z');
  assert.equal(second!.id, 'nowcoast-radar:conus_base_reflectivity_mosaic:2026-09-27t21-40-00.000z');
  const m = provider.manifest;
  assert.equal(m.refreshPolicy.intervalMs, 300_000, 'a poll every five minutes, as MRMS updates');
  assert.ok(m.refreshPolicy.maxRequestsPerMinute >= 2, 'the poll and the overlays() refresh after it');
  // The main process caches only catalogue basemaps with a tileCache block (tile-cache.ts); an
  // overlay is fetched by the renderers straight from its host, so a frame is never served stale.
  for (const e of MAP_PROVIDER_CATALOG)
    assert.ok(!(e.tileCache && JSON.stringify(e).includes('nowcoast.noaa.gov')), e.id);
});

/** Observations of one definition over its fixture, through the state and event engines as the runtime runs them. */
async function eventsOf(id: string, fixture: string, nowIso: string) {
  const def = definition(id);
  const observations = await poll(def, read(fixture), nowIso);
  const clock = { now: () => Date.parse(nowIso) };
  const state = new WorldState({ clock, flushDelayMs: 0 });
  const engine = new EventEngine({ clock });
  engine.attach(state);
  const freshness = defaultConnectorRegistry.createProvider(def).manifest.refreshPolicy.freshness;
  state.ingest(observations, { snapshot: true, providerId: def.id, ...(freshness ? { freshness } : {}) });
  state.flush();
  const events = engine.store.ofType('weather-alert');
  engine.dispose();
  return { observations, events };
}

const feed = new FeedBuilder();
const shape = (e: WorldEvent | undefined) => e?.geometry?.type;

test('NHC: every active storm has a cone polygon and a track line, drawn as events, kept out of the feed', async () => {
  const cones = await eventsOf(
    'nhc-forecast-cones',
    'fixtures/connectors/hazards/nhc-forecast-cone.geojson',
    '2026-09-23T12:00:00.000Z',
  );
  assert.equal(cones.events.length, 4);
  const polo = cones.events.find((e) => e.title === 'Polo')!;
  assert.equal(shape(polo), 'Polygon');
  assert.equal(polo.severity, 'INFO', 'the storm event carries the severity; the cone does not repeat it');
  assert.equal(feed.isRelevant(polo), false);
  assert.match(polo.summary ?? '', /^NHC 5-day forecast cone from /);
  assert.ok(polo.endAt && Date.parse(polo.endAt) > Date.parse('2026-09-23T12:00:00.000Z'), 'still drawn');
  const tracks = await eventsOf(
    'nhc-forecast-tracks',
    'fixtures/connectors/hazards/nhc-forecast-track.geojson',
    '2026-09-23T12:00:00.000Z',
  );
  assert.deepEqual(tracks.events.map((e) => [e.title, shape(e)]).sort(), [
    ['Fay', 'LineString'],
    ['Nolo', 'LineString'],
    ['Polo', 'LineString'],
    ['Rachel', 'LineString'],
  ]);
  // The track's marker sits at its first point, the storm's current position.
  const fay = tracks.observations.find((o) => o.externalId === 'AT1')!;
  assert.deepEqual(fay.position, { latitude: 28.5, longitude: -43.8 });
  // No storm: an empty layer is an empty, healthy answer.
  const quiet = await poll(
    definition('nhc-forecast-cones'),
    read('fixtures/connectors/hazards/arcgis-empty.geojson'),
    '2026-09-23T12:00:00.000Z',
  );
  assert.deepEqual(quiet, []);
});

test('NIFC: perimeters are polygons with name, acres and containment; prescribed burns are left out', async () => {
  const { observations, events } = await eventsOf(
    'nifc-wildfire-perimeters',
    'fixtures/connectors/hazards/nifc-perimeters.geojson',
    '2026-09-27T12:00:00.000Z',
  );
  assert.equal(observations.length, 3);
  assert.ok(!observations.some((o) => o.payload['incidentType'] === 'RX'));
  const shaw = observations.find((o) => o.payload['name'] === 'Shaw')!;
  assert.equal(shaw.objectType, 'weather-alert');
  assert.equal(shaw.geometry?.type, 'Polygon');
  assert.equal(shaw.payload['areaAcres'], 3459.2);
  assert.equal(shaw.payload['percentContained'], 0);
  const e = events.find((x) => x.title === 'Shaw')!;
  assert.equal(shape(e), 'Polygon');
  assert.equal(e.startAt, '2026-06-20T23:01:00.000Z', 'the fire began when it was discovered');
  assert.equal(feed.isRelevant(e), false, 'a perimeter is a map layer, not news');
  // A perimeter last redrawn in April is still current while WFIGS lists it.
  assert.ok(events.every((x) => !x.endAt || Date.parse(x.endAt) > Date.parse('2026-09-27T12:00:00.000Z')));
});

test('GDACS: one current event per alert, its level as severity, its report linked; only the centroid row is read', async () => {
  const { observations, events } = await eventsOf(
    'gdacs-tropical-cyclones',
    'fixtures/connectors/hazards/gdacs-events.geojson',
    '2026-09-23T20:00:00.000Z',
  );
  assert.deepEqual(
    observations.map((o) => o.externalId),
    ['1001399'],
  );
  const red = events[0]!;
  assert.equal(red.title, 'Tropical Cyclone SAMPLE-26');
  assert.equal(red.severity, 'SEVERE', 'alert score 3 (red)');
  assert.equal(feed.isRelevant(red), true);
  assert.equal(
    observations[0]!.payload['detailUrl'],
    'https://www.gdacs.org/report.aspx?eventid=1001399&episodeid=9&eventtype=TC',
  );
  const levels: Record<string, string> = {};
  for (const id of GDACS) {
    const r = await eventsOf(id, 'fixtures/connectors/hazards/gdacs-events.geojson', '2026-09-23T20:00:00.000Z');
    for (const ev of r.events) levels[ev.title] = ev.severity ?? 'INFO';
  }
  assert.deepEqual(levels, {
    'Earthquake in Exampleland': 'MODERATE',
    'Earthquake in Sampleland': 'MINOR',
    'Tropical Cyclone SAMPLE-26': 'SEVERE',
    'Flood in Exampleland': 'MINOR',
    'Volcano Mount Example': 'MODERATE',
    'Drought in Exampleland': 'MODERATE',
    'Forest fires in Sampleland': 'MINOR',
  });
});
