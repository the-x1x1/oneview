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
import { BUILT_IN_LENSES, DEFAULT_RULES, MAP_PROVIDER_CATALOG } from '@worldview/render-core';
import { WorldState } from '@worldview/state-engine';
import { EventEngine, FeedBuilder } from '@worldview/event-engine';
import { loadSidecar, sidecarPathFor } from '@worldview/tool-connector-validator';
import { findDefinitions } from '@worldview/tool-license-audit';

/**
 * The definitions this directory ships (2026-09-27, hazard layers): NOAA nowCOAST radar and
 * GOES infrared overlays, NHC forecast cones and tracks, NIFC wildfire perimeters and six
 * GDACS alert lists; and (2026-09-28, worldwide weather) NASA GIBS geostationary infrared from
 * GOES-East, GOES-West and Himawari-9 and IMERG precipitation, NWS storm reports and the SPC
 * day 1 outlook; and (2026-09-28, imagery comparison) the GIBS VIIRS true-colour days from Suomi
 * NPP and NOAA-20, off by default; and (2026-09-29) EUMETSAT's Meteosat 0° and IODC infrared from
 * EUMETView, which close the gap from 0° to 80° E. What each one's sidecar cannot say is checked here: how they load in
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
  'nhc-forecast-points',
  'nhc-past-track',
  'nhc-wind-field',
  'nifc-wildfire-perimeters',
  'nws-storm-reports',
  'spc-day1-outlook',
];
/** NASA GIBS: open, credit requested (and so required here); Himawari is JMA's, distributed openly by NOAA. */
const GIBS = [
  'gibs-goes-east-infrared',
  'gibs-goes-west-infrared',
  'gibs-himawari-infrared',
  'gibs-imerg-precipitation',
];
/** EUMETSAT EUMETView infrared: Core data under CC BY 4.0, credited as the Data Policy words it. */
const EUMETSAT = ['eumetsat-meteosat-infrared', 'eumetsat-iodc-infrared'];
/** Every geostationary infrared slice, west to east: together they go once round the globe. */
const INFRARED_SLICES = [
  'gibs-goes-west-infrared',
  'gibs-goes-east-infrared',
  'eumetsat-meteosat-infrared',
  'eumetsat-iodc-infrared',
  'gibs-himawari-infrared',
];
/** NASA GIBS daily true colour (VIIRS): the same licence as GIBS above, but off until turned on. */
const TRUE_COLOUR = ['gibs-viirs-snpp-true-colour', 'gibs-viirs-noaa20-true-colour'];
/** nowCOAST lightning: a NOAA-derived product released for public distribution, credited with its derivation. */
const LIGHTNING = ['nowcoast-strike-density'];
/** Raster overlays: their switch is the source itself, not an object type. */
const OVERLAY_CONNECTORS = ['wms', 'wmts'];
const GDACS = [
  'gdacs-earthquakes',
  'gdacs-tropical-cyclones',
  'gdacs-floods',
  'gdacs-volcanoes',
  'gdacs-droughts',
  'gdacs-wildfires',
];

test('the shipped set is the hazard layers, and each passes the shared suite from its sidecar', async () => {
  assert.deepEqual(
    [...byId.keys()].sort(),
    [...PUBLIC_DOMAIN, ...GIBS, ...EUMETSAT, ...TRUE_COLOUR, ...LIGHTNING, ...GDACS].sort(),
  );
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
  for (const id of GIBS) {
    const m = defaultConnectorRegistry.createProvider(definition(id)).manifest;
    assert.equal(m.commercialReview, 'approved', id);
    assert.equal(m.enabledByDefault, true, id);
    assert.equal(m.dataPolicy.commercialUseAllowed, true, id);
    assert.equal(m.dataPolicy.attributionRequired, true, `${id}: NASA asks for GIBS to be credited`);
    assert.match(m.attribution.text, /NASA GIBS/, id);
    assert.deepEqual(m.allowedHosts, ['gibs.earthdata.nasa.gov'], id);
    assert.equal(m.attribution.licenseId, id === 'gibs-himawari-infrared' ? undefined : 'US-PD', id);
  }
  for (const id of EUMETSAT) {
    const m = defaultConnectorRegistry.createProvider(definition(id)).manifest;
    assert.equal(m.commercialReview, 'approved', id);
    assert.equal(m.enabledByDefault, true, `${id}: Core data, Free and Unrestricted`);
    assert.equal(m.dataPolicy.commercialUseAllowed, true, id);
    assert.equal(m.dataPolicy.redistributionAllowed, true, id);
    assert.equal(m.dataPolicy.attributionRequired, true, `${id}: CC BY 4.0 and Data Policy article 6.3`);
    assert.equal(m.attribution.licenseId, 'CC-BY-4.0', id);
    // "[Contains modified] EUMETSAT [Meteosat/Metop] [data/product] [Year]": the tiles are faded, so modified.
    assert.match(m.attribution.text, /contains modified EUMETSAT Meteosat product \d{4}/, id);
    assert.deepEqual(m.allowedHosts, ['view.eumetsat.int'], id);
  }
  for (const id of TRUE_COLOUR) {
    const m = defaultConnectorRegistry.createProvider(definition(id)).manifest;
    assert.equal(m.commercialReview, 'approved', id);
    assert.equal(m.enabledByDefault, false, `${id}: an opaque picture of the Earth is turned on for a purpose`);
    assert.equal(m.dataPolicy.commercialUseAllowed, true, id);
    assert.equal(m.dataPolicy.attributionRequired, true, id);
    assert.match(m.attribution.text, /VIIRS .*NASA GIBS/, id);
    assert.equal(m.attribution.licenseId, 'US-PD', id);
    assert.deepEqual(m.allowedHosts, ['gibs.earthdata.nasa.gov'], id);
  }
  assert.match(
    defaultConnectorRegistry.createProvider(definition('gibs-himawari-infrared')).manifest.attribution.text,
    /JMA Himawari-9 \(NOAA distribution\)/,
  );
  for (const id of LIGHTNING) {
    const m = defaultConnectorRegistry.createProvider(definition(id)).manifest;
    assert.equal(m.commercialReview, 'approved', id);
    assert.equal(m.enabledByDefault, true, `${id}: transparent where there is no lightning`);
    assert.equal(m.dataPolicy.redistributionAllowed, true, id);
    assert.equal(m.dataPolicy.attributionRequired, true, id);
    assert.match(m.attribution.text, /derived from Vaisala NLDN\/GLD360/, id);
    assert.equal(
      m.attribution.licenseId,
      undefined,
      `${id}: derived from licensed detections, so not labelled public domain`,
    );
    assert.deepEqual(m.allowedHosts, ['nowcoast.noaa.gov'], id);
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
      if (!OVERLAY_CONNECTORS.includes(d.connector))
        assert.ok(lenses.get(c)!.objectTypes.includes(d.objectType), `${id} in ${c}`);
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

test('infrared: each satellite draws its own slice, the five meeting without overlap once round the globe; IMERG covers it all', () => {
  const extent = (id: string) => String((definition(id).endpoint!.query as Record<string, unknown>)['extent'] ?? '');
  assert.equal(extent('gibs-goes-west-infrared'), '-180,-60,-106,60');
  // Each seam about halfway between two satellites' sub-points (GOES-West 137.2° W, GOES-East
  // 75.2° W, Meteosat 0°, Meteosat-9 45.5° E, Himawari-9 140.7° E), so every longitude is
  // drawn by the satellite that sees it least obliquely. A seam at a satellite's limb draws
  // a cold, bright, grazing-angle picture that shows through the clouds-only fade as a veil.
  assert.equal(extent('gibs-goes-east-infrared'), '-106,-60,-37.5,60');
  assert.equal(extent('eumetsat-meteosat-infrared'), '-37.5,-60,22.5,60');
  assert.equal(extent('eumetsat-iodc-infrared'), '22.5,-60,93,60');
  assert.equal(extent('gibs-himawari-infrared'), '93,-60,180,60');
  assert.equal(extent('gibs-imerg-precipitation'), '');
  // West to east, each slice starts where the last ended, from the antimeridian back to it:
  // no longitude without infrared, none drawn twice. All keep to 60° N–60° S (polar ice reads as storm tops).
  let east = -180;
  for (const id of INFRARED_SLICES) {
    const [w, s, e, n] = extent(id).split(',').map(Number);
    assert.equal(w, east, `${id} starts where the slice before it ends`);
    assert.ok(e! > w!, id);
    assert.deepEqual([s, n], [-60, 60], id);
    east = e!;
  }
  assert.equal(east, 180);
  assert.deepEqual(
    [...byId.keys()].filter((id) => /infrared/.test(id) && id !== 'nowcoast-goes-infrared').sort(),
    [...INFRARED_SLICES].sort(),
    'every infrared slice is in the ring',
  );
  for (const id of [...GIBS, ...EUMETSAT]) {
    const q = definition(id).endpoint!.query as Record<string, unknown>;
    assert.equal(q['time'], 'latest', id);
    assert.equal(q['role'], 'overlay', id);
    assert.ok(Number(q['opacity']) > 0 && Number(q['opacity']) < 1, `${id}: the map reads through`);
  }
  for (const id of GIBS)
    // One layer's capabilities, not GIBS's whole catalogue.
    assert.match(
      definition(id).endpoint!.url,
      new RegExp(`wmts\\.cgi\\?LAYER=${String((definition(id).endpoint!.query as Record<string, unknown>)['layer'])}$`),
      id,
    );
});

test('EUMETView infrared: the newest frame rides on every tile as TIME with milliseconds, 512-pixel tiles to zoom 5, clouds only', async () => {
  for (const [id, ws, bounds] of [
    ['eumetsat-meteosat-infrared', 'msg_fes', { west: -37.5, south: -60, east: 22.5, north: 60 }],
    ['eumetsat-iodc-infrared', 'msg_iodc', { west: 22.5, south: -60, east: 93, north: 60 }],
  ] as const) {
    const fixture = ws.replace('_', '-');
    let wmts = read(`fixtures/connectors/hazards/eumetview-${fixture}-ir108-wmts-capabilities.xml`);
    const requests: string[] = [];
    const def = definition(id);
    const provider = defaultConnectorRegistry.createProvider(def);
    const ctx = testing.createFixtureContext({
      providerId: def.id,
      clock: new testing.VirtualClock(Date.parse('2026-09-29T05:12:00Z')),
      responder: (req) => {
        requests.push(req.url);
        return { status: 200, body: wmts };
      },
    });
    await provider.initialize(ctx);
    await provider.start();
    const [overlay] = (await provider.overlays!()) as RasterOverlay[];
    assert.ok(overlay && overlay.kind === 'wmts', id);
    assert.equal(overlay.frame, '2026-09-29T04:45:00Z', id);
    // EPSG:900913 answers every tile with an error; the 512-pixel set answers, and only for a
    // TIME spelled with milliseconds (fixtures/connectors/hazards/README.md).
    assert.equal(
      overlay.url,
      `https://view.eumetsat.int/geoserver/${ws}/ir108/gwc/service/wmts/rest/ir108/raster/EPSG%3A3857%20-%20512/{TileMatrix}/{TileRow}/{TileCol}?format=image/png&TIME=2026-09-29T04:45:00.000Z`,
    );
    assert.equal(overlay.id, `${id}:ir108:2026-09-29t04-45-00z`);
    assert.equal(overlay.tileSize, 512);
    assert.deepEqual([overlay.minZoom, overlay.maxZoom], [0, 5], `${id}: a 3 km picture is not asked for past zoom 5`);
    assert.equal(overlay.tileMatrixLabels?.[5], 'EPSG:3857 - 512:5');
    assert.deepEqual(overlay.bounds, bounds);
    assert.deepEqual(overlay.fadeBelow, { from: 80, to: 130, monochrome: true });
    assert.equal(overlay.featherDeg, 5);
    assert.equal(overlay.opacity, 0.85);
    assert.deepEqual(requests, [
      `https://view.eumetsat.int/geoserver/${ws}/ir108/gwc/service/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0`,
    ]);
    // The next frame is a new descriptor.
    wmts = wmts.replace(/2026-09-29T04:45:00(\.000)?Z/g, '2026-09-29T05:00:00$1Z');
    await provider.query!({ signal: new AbortController().signal, background: true });
    const [next] = (await provider.overlays!()) as RasterOverlay[];
    assert.equal(next!.kind === 'wmts' && next!.frame, '2026-09-29T05:00:00Z', id);
    assert.match(next!.kind === 'wmts' ? next!.url : '', /&TIME=2026-09-29T05:00:00\.000Z$/);
  }
});

test('storm reports: times read whether the service gives epoch milliseconds or ISO 8601', async () => {
  // Live, the ArcGIS connector turns the layer's date fields into ISO 8601 before mapping
  // (esri-json.ts normalizeDates, once it has read the layer's fields); the fixture keeps the
  // service's epoch milliseconds. On 2026-09-29 the laptop's log warned that the definition's
  // unixMillis would drop every live report's time: both forms must read the same.
  const raw = read('fixtures/connectors/hazards/nws-storm-reports.geojson');
  const iso = raw.replace(
    /"(lsr_validtime)": (\d{13})/g,
    (_m, k: string, ms: string) => `"${k}": "${new Date(Number(ms)).toISOString()}"`,
  );
  assert.notEqual(iso, raw);
  const now = '2026-09-23T12:00:00.000Z';
  const fromMs = await poll(definition('nws-storm-reports'), raw, now);
  const fromIso = await poll(definition('nws-storm-reports'), iso, now);
  assert.equal(fromIso.length, fromMs.length);
  assert.deepEqual(fromIso.map((o) => o.observedAt).sort(), fromMs.map((o) => o.observedAt).sort());
});

test('storm reports: tornado, hail and wind reports as points with their type; rain is left out', async () => {
  const { observations, events } = await eventsOf(
    'nws-storm-reports',
    'fixtures/connectors/hazards/nws-storm-reports.geojson',
    '2026-09-23T12:00:00.000Z',
  );
  assert.deepEqual(observations.map((o) => o.payload['reportType']).sort(), [
    'Hail',
    'Hail',
    'Hail',
    'Tornado',
    'Tstm Wnd Dmg',
    'Tstm Wnd Gst',
  ]);
  const tornado = observations.find((o) => o.payload['reportType'] === 'Tornado')!;
  assert.equal(tornado.objectType, 'weather-alert');
  assert.equal(tornado.geometry, undefined, 'a point, no shape');
  assert.equal(tornado.payload['senderName'], 'Wichita KS');
  const gust = observations.find((o) => o.payload['reportType'] === 'Tstm Wnd Gst')!;
  assert.equal(gust.payload['magnitude'], '55');
  assert.equal(gust.payload['magnitudeUnits'], 'mph');
  assert.equal(gust.payload['description'], undefined, 'a blank remark is no remark');
  // The two from three days before the clock (the fixture's rows come from the 72-hour layer)
  // have outlived the definition's 26-hour expiry; the rest are drawn.
  assert.deepEqual(events.map((e) => e.title).sort(), ['Hail', 'Tornado', 'Tstm Wnd Dmg', 'Tstm Wnd Gst']);
  assert.ok(
    events.every((e) => !feed.isRelevant(e)),
    'reports are a map layer; warnings are the news',
  );
});

test('SPC outlook: one area per category, coloured by category, expiring when the outlook does', async () => {
  const { observations, events } = await eventsOf(
    'spc-day1-outlook',
    'fixtures/connectors/hazards/spc-day1-outlook.geojson',
    '2026-09-23T14:00:00.000Z',
  );
  assert.deepEqual(
    observations.map((o) => o.payload['spcCategory']),
    ['TSTM', 'MRGL', 'SLGT', 'ENH'],
  );
  const tstm = observations[0]!;
  assert.equal(tstm.geometry?.type, 'MultiPolygon');
  assert.equal(tstm.payload['expires'], '2026-09-24T12:00:00.000Z');
  assert.equal(tstm.payload['title'], 'General Thunderstorms Risk');
  const slight = events.find((e) => e.title === 'Slight Risk')!;
  assert.equal(shape(slight), 'Polygon');
  // Drawn at least until the outlook expires; the next issuance replaces it sooner.
  assert.ok(slight.endAt && Date.parse(slight.endAt) >= Date.parse('2026-09-24T12:00:00.000Z'), slight.endAt);
  const rule = DEFAULT_RULES.find((r) => r.objectTypes.includes('weather-alert'))!;
  const suffix = (v: string) => rule.classBy!.suffixes[v];
  assert.deepEqual(['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'].map(suffix), [
    'spc-tstm',
    'spc-mrgl',
    'spc-slgt',
    'spc-enh',
    'spc-mdt',
    'spc-high',
  ]);
});

test('GDACS cyclones carry their maximum wind', async () => {
  const { observations } = await eventsOf(
    'gdacs-tropical-cyclones',
    'fixtures/connectors/hazards/gdacs-events.geojson',
    '2026-09-23T20:00:00.000Z',
  );
  assert.equal(observations[0]!.payload['maxWindKmh'], 231.5);
});

test('GIBS true colour: latest is the newest finished day of the time domain, not the weeks-old default the capabilities name', async () => {
  const domains = read('fixtures/connectors/hazards/gibs-viirs-truecolor-domains.xml');
  for (const [id, caps, layer] of [
    [
      'gibs-viirs-snpp-true-colour',
      'fixtures/connectors/hazards/gibs-viirs-snpp-truecolor-wmts-capabilities.xml',
      'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    ],
    [
      'gibs-viirs-noaa20-true-colour',
      'fixtures/connectors/hazards/gibs-viirs-noaa20-truecolor-wmts-capabilities.xml',
      'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    ],
  ] as const) {
    const def = definition(id);
    const provider = defaultConnectorRegistry.createProvider(def);
    const requests: string[] = [];
    const ctx = testing.createFixtureContext({
      providerId: def.id,
      clock: new testing.VirtualClock(Date.parse('2026-09-28T16:15:00Z')),
      responder: (req) => {
        requests.push(req.url);
        return { status: 200, body: /REQUEST=GetCapabilities/.test(req.url) ? read(caps) : domains };
      },
    });
    await provider.initialize(ctx);
    await provider.start();
    const [overlay] = (await provider.overlays!()) as RasterOverlay[];
    assert.ok(overlay && overlay.kind === 'wmts', id);
    assert.equal(overlay.frame, '2026-09-27', `${id}: at 16:15Z the 28th is still being imaged; the 27th is whole`);
    assert.equal(
      overlay.url,
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/2026-09-27/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpeg`,
    );
    assert.equal(overlay.maxZoom, 9);
    assert.equal(overlay.opacity, 1);
    assert.equal(overlay.role ?? 'overlay', 'overlay');
    assert.equal(requests.length, 5, 'the capabilities, two days of the domain, three tiles of the new day');
    assert.match(requests[2]!, /\/2026-09-27\/GoogleMapsCompatible_Level9\/1\/1\/1\.jpeg$/);
    assert.match(requests[3]!, /\/2026-09-27\/GoogleMapsCompatible_Level9\/3\/4\/4\.jpeg$/);
    assert.match(requests[4]!, /\/2026-09-27\/GoogleMapsCompatible_Level9\/8\/\d+\/\d+\.jpeg$/);
    assert.match(requests[1]!, /\/all\/2026-09-26--2026-09-29\.xml$/);
  }
});

test('nowCOAST lightning: the newest density frame is the TIME of every tile, over its own coverage', async () => {
  let body = read('fixtures/connectors/hazards/nowcoast-lightning-wms130-capabilities.xml');
  const provider = await started(definition('nowcoast-strike-density'), () => body, '2026-09-27T21:40:00.000Z');
  const [first] = (await provider.overlays!()) as RasterOverlay[];
  assert.ok(first && first.kind === 'wms');
  assert.equal(first.url, 'https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/wms');
  assert.equal(first.layers, 'ldn_lightning_strike_density');
  assert.equal(first.styles, 'lightning_density');
  assert.equal(first.parameters?.['TIME'], '2026-09-27T21:30:00.000Z');
  assert.equal(first.role, 'overlay');
  assert.ok(first.opacity !== undefined && first.opacity > 0.5 && first.opacity < 1, 'light enough to leave on');
  body = read('fixtures/connectors/hazards/nowcoast-lightning-wms130-capabilities-next.xml');
  await provider.query!({ signal: new AbortController().signal, background: true });
  const [second] = (await provider.overlays!()) as RasterOverlay[];
  assert.equal(second!.kind === 'wms' && second!.parameters?.['TIME'], '2026-09-27T21:45:00.000Z');
  assert.equal(provider.manifest.refreshPolicy.intervalMs, 300_000);
  // Overlays draw in the order the bundled files load (by name): lightning above the radar
  // it mostly coincides with, or the radar's reds would hide it over the US.
  assert.ok(files.indexOf(byId.get('nowcoast-strike-density')!) > files.indexOf(byId.get('nowcoast-radar')!));
});

test('NHC storm layers: forecast positions with time and wind, past track by strength, the wind field in rings', async () => {
  const at = '2026-09-23T12:00:00.000Z';
  const points = await eventsOf('nhc-forecast-points', 'fixtures/connectors/hazards/nhc-forecast-points.geojson', at);
  // The tau 0 rows are the storms themselves (nhc-storms): left out.
  assert.ok(points.observations.every((o) => Number(o.payload['forecastHours']) > 0));
  const nolo24 = points.observations.find((o) => o.externalId === '2616')!;
  assert.equal(nolo24.payload['forecastTime'], '8:00 AM Tue');
  assert.equal(nolo24.payload['intensityKt'], 110);
  assert.equal(nolo24.payload['forecastPressureMb'], 9999, 'as served: 9999 is "none", which the panel leaves out');
  assert.ok(
    points.events.every((e) => !feed.isRelevant(e)),
    'forecast positions are a map layer',
  );
  const past = await eventsOf('nhc-past-track', 'fixtures/connectors/hazards/nhc-past-track.geojson', at);
  assert.deepEqual(
    past.observations.map((o) => o.payload['trackCategory']),
    ['0', '0', '0', '1', '5', '4', '0'],
  );
  assert.ok(past.observations.every((o) => o.geometry?.type === 'LineString'));
  const wind = await eventsOf('nhc-wind-field', 'fixtures/connectors/hazards/nhc-wind-field.geojson', at);
  assert.equal(wind.observations.length, 8, 'the row with no radii and no shape is refused');
  assert.deepEqual(
    wind.observations.filter((o) => o.payload['stormId'] === 'ep152026').map((o) => o.payload['windRadiiKt']),
    [34, 50, 64],
  );
  assert.ok(wind.observations.every((o) => o.geometry?.type === 'Polygon'));
  assert.ok(wind.events.every((e) => !feed.isRelevant(e)));
});
