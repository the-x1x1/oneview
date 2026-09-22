import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, zoomToAltitudeM, type RenderFeature } from '@worldview/render-core';
import {
  buildEmptyStyle,
  buildRasterStyle,
  buildWorldviewStyle,
  styleForBasemap,
  DARK_PALETTE,
  LIGHT_PALETTE,
  DEFAULT_GLYPHS_URL,
} from './styles/worldview-dark.js';
import { validateStyle, type MapStyle, type SymbolLayer } from './styles/spec.js';
import { interactiveLayerIds, overlayLayerIds, overlayLayers, overlaySource } from './layers.js';
import { SourceModel, clusterOptionsFromRules } from './sources.js';
import { circleRing, featureGeometry, iconImageId, toOverlayFeature } from './geojson.js';
import { toPickResult } from './picking.js';
import { mapToViewState, pitchDegreesToMapLibre, resolveMapFlyTarget, viewStateToMap } from './view.js';
import { attributionMarkup } from './attribution.js';
import { ensurePmtilesProtocol, pmtilesSourceUrl, removePmtilesProtocol } from './pmtiles.js';
import { IconRegistry, parseIconImageId } from './images.js';
import { createFakeMapLibre, createFakePmtiles, fakeImageCanvasFactory, FakeMap } from './testing/fake-maplibre.js';

const PROTOMAPS_LAYERS = new Set([
  'earth',
  'landuse',
  'natural',
  'water',
  'buildings',
  'roads',
  'transit',
  'boundaries',
  'places',
  'pois',
  'physical_line',
  'physical_point',
]);

test('style: worldview-dark is a valid style for the Protomaps basemap schema (unique ids, known sources and source-layers, glyphs for text)', () => {
  const style = buildWorldviewStyle({
    sourceUrl: 'pmtiles://packs/europe.pmtiles',
    variant: 'dark',
    attribution: '© OpenStreetMap contributors',
    glyphs: DEFAULT_GLYPHS_URL,
  });
  assert.deepEqual(validateStyle(style), []);
  assert.equal(style.version, 8);
  assert.ok(
    style.sources['basemap'] &&
      style.sources['basemap'].type === 'vector' &&
      style.sources['basemap'].url === 'pmtiles://packs/europe.pmtiles',
  );
  const ids = style.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const l of style.layers)
    if (l.type !== 'background')
      assert.ok(PROTOMAPS_LAYERS.has(l['source-layer']!), `${l.id} uses a Protomaps layer (${l['source-layer']})`);
  assert.equal(style.layers[0]!.type, 'background');
  assert.ok(
    ids.indexOf('water') < ids.indexOf('roads-highway') &&
      ids.indexOf('roads-highway') < ids.indexOf('places-locality'),
    'water under roads under labels',
  );
  const symbols = style.layers.filter((l): l is SymbolLayer => l.type === 'symbol');
  assert.ok(symbols.length >= 4);
  for (const s of symbols) assert.deepEqual(s.layout['text-font'], ['Noto Sans Regular']);
  assert.equal(
    (style.layers[0] as { paint: { 'background-color': string } }).paint['background-color'],
    DARK_PALETTE.background,
  );
  const light = buildWorldviewStyle({
    sourceUrl: 'pmtiles://x',
    variant: 'light',
    attribution: '',
    glyphs: DEFAULT_GLYPHS_URL,
  });
  assert.equal(
    (light.layers[0] as { paint: { 'background-color': string } }).paint['background-color'],
    LIGHT_PALETTE.background,
  );
  assert.deepEqual(validateStyle(light), []);
});

test('style: validation catches broken styles; raster/empty/basemap-descriptor styles are valid', () => {
  const broken: MapStyle = {
    version: 8,
    name: 'x',
    sources: { v: { type: 'vector', url: 'pmtiles://a' }, r: { type: 'raster', tiles: [] } },
    layers: [
      { id: 'a', type: 'fill', source: 'v', paint: { 'fill-color': '#000' } },
      { id: 'a', type: 'fill', source: 'missing', paint: { 'fill-color': '#000' } },
      { id: 'b', type: 'fill', source: 'r', paint: { 'fill-color': '#000' } },
      { id: 'c', type: 'symbol', source: 'v', 'source-layer': 'places', layout: { 'text-field': ['get', 'name'] } },
    ],
  };
  const problems = validateStyle(broken).map((p) => p.message);
  assert.ok(problems.some((m) => /duplicate layer id/.test(m)));
  assert.ok(problems.some((m) => /unknown source "missing"/.test(m)));
  assert.ok(problems.some((m) => /without source-layer/.test(m)));
  assert.ok(problems.some((m) => /raster source used by a non-raster/.test(m)));
  assert.ok(problems.some((m) => /no glyphs url/.test(m)));
  assert.ok(problems.some((m) => /raster source "r" has no tiles/.test(m)));

  assert.deepEqual(
    validateStyle(
      buildRasterStyle({ id: 'esri', tiles: ['https://t/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Powered by Esri' }),
    ),
    [],
  );
  assert.deepEqual(validateStyle(buildEmptyStyle()), []);
  const fromPack = styleForBasemap({
    kind: 'pmtiles',
    id: 'pack',
    url: 'packs/na.pmtiles',
    styleId: 'worldview-dark',
    attribution: 'OSM',
  });
  assert.ok(
    typeof fromPack === 'object' &&
      fromPack.sources['basemap']?.type === 'vector' &&
      fromPack.sources['basemap'].url === 'pmtiles://packs/na.pmtiles',
  );
  assert.equal(
    styleForBasemap({
      kind: 'vector-style',
      id: 'ofm',
      styleUrl: 'https://tiles.openfreemap.org/styles/dark',
      attribution: 'OpenFreeMap',
    }),
    'https://tiles.openfreemap.org/styles/dark',
  );
  const esri = styleForBasemap({ kind: 'esri-world-imagery', id: 'esri', attribution: '' });
  assert.ok(
    typeof esri === 'object' &&
      esri.sources['basemap']?.type === 'raster' &&
      /Powered by Esri/.test(esri.sources['basemap'].attribution ?? ''),
  );
  const globeOnly = styleForBasemap({ kind: 'cesium-natural-earth', id: 'ne', attribution: '' });
  assert.ok(typeof globeOnly === 'object' && Object.keys(globeOnly.sources).length === 0);
});

test('overlay layers: one source per layer, unique ids, cluster options from rules, valid against the style validator', () => {
  // No default rule clusters any more — MapLibre's source-level clustering was the 2D half
  // of the grouping the operator did not want, and it re-ran in the worker on every zoom.
  assert.equal(clusterOptionsFromRules(DEFAULT_RULES).size, 0, 'the default 2D map groups nothing');
  // The mechanism stays for a lens that opts in.
  const clusters = clusterOptionsFromRules(
    DEFAULT_RULES.map((r) => (r.styleClass === 'aircraft' ? { ...r, clusterPx: 24 } : r)),
  );
  assert.equal(clusters.get('aircraft')?.radiusPx, 24);
  assert.equal(clusters.has('earthquake'), false, 'clusterPx 0 → no clustering');
  const opts = { fontStack: ['Noto Sans Regular'], cluster: clusters.get('aircraft')! };
  const source = overlaySource('aircraft', opts);
  assert.equal(source.cluster, true);
  assert.equal(source.clusterMaxZoom, 9);
  assert.ok(source.clusterProperties?.['color']);
  const layers = overlayLayers('aircraft', opts);
  assert.deepEqual(
    layers.map((l) => l.id),
    overlayLayerIds('aircraft'),
  );
  assert.ok(interactiveLayerIds('aircraft').every((id) => layers.some((l) => l.id === id)));
  const style: MapStyle = {
    version: 8,
    name: 't',
    glyphs: DEFAULT_GLYPHS_URL,
    sources: { 'wv:aircraft': source },
    layers,
  };
  assert.deepEqual(validateStyle(style), []);
  const symbol = layers.find((l) => l.id === 'wv:aircraft:symbol') as SymbolLayer;
  assert.equal(symbol.layout['icon-allow-overlap'], false);
  assert.equal(symbol.layout['text-optional'], true);
  assert.deepEqual(symbol.layout['symbol-sort-key'], ['get', 'sortKey']);
  assert.deepEqual(symbol.layout['icon-rotate'], ['get', 'rotation']);
});

test('geojson: feature conversion carries style properties; circles and density cells become polygons', () => {
  const point: RenderFeature = {
    id: 'obj:a',
    objectId: 'a',
    geometry: { kind: 'point', position: { latitude: 10, longitude: 20, altitudeM: 900 } },
    style: {
      styleClass: 'aircraft',
      icon: 'aircraft',
      rotationDegrees: 45,
      label: 'X',
      labelPriority: 60,
      freshness: 'STALE',
    },
    interactive: true,
    priority: 50,
    layer: 'aircraft',
  };
  const gj = toOverlayFeature(point)!;
  assert.deepEqual(gj.geometry, { type: 'Point', coordinates: [20, 10, 900] });
  assert.equal(gj.properties.kind, 'point');
  assert.equal(gj.properties.icon, iconImageId('aircraft', gj.properties.color));
  assert.equal(gj.properties.rotation, 45);
  assert.equal(gj.properties.sortKey, -60);
  assert.equal(gj.properties.opacity, 0.5, 'STALE dims');
  assert.equal(gj.properties.label, 'X');
  const circle: RenderFeature = {
    ...point,
    id: 'c',
    geometry: { kind: 'circle', center: { latitude: 0, longitude: 0 }, radiusM: 1000 },
  };
  const cg = featureGeometry(circle)!;
  assert.equal(cg.type, 'Polygon');
  assert.equal((cg as { coordinates: number[][][] }).coordinates[0]!.length, 49);
  const ring = circleRing({ latitude: 0, longitude: 0 }, 111_320, 4);
  assert.ok(Math.abs(ring[0]![1]! - 1) < 0.01, 'north point ~1° away');
  const density: RenderFeature = {
    ...point,
    id: 'd',
    geometry: { kind: 'density', bounds: { west: 0, south: 0, east: 1, north: 1 }, count: 9, intensity: 0.5 },
    style: { styleClass: 'fire.density' },
  };
  const dg = toOverlayFeature(density)!;
  assert.equal(dg.properties.kind, 'density');
  assert.equal(dg.properties.count, 9);
  assert.ok(dg.properties.fillOpacity > 0.3 && dg.properties.fillOpacity < 0.5);
  assert.equal(
    featureGeometry({ ...point, geometry: { kind: 'line', positions: [{ latitude: 0, longitude: 0 }] } }),
    undefined,
    'degenerate lines dropped',
  );
  assert.equal(
    featureGeometry({ ...point, geometry: { kind: 'circle', center: { latitude: 0, longitude: 0 }, radiusM: 0 } }),
    undefined,
  );
});

test('source model: diff application marks only touched layers dirty; replaceLayers and layer moves', () => {
  const model = new SourceModel();
  const f = (id: string, layer: string, lat = 0): RenderFeature => ({
    id,
    geometry: { kind: 'point', position: { latitude: lat, longitude: 0 } },
    style: { styleClass: layer },
    interactive: true,
    priority: 1,
    layer,
  });
  assert.deepEqual(model.apply({ upsert: [f('a', 'aircraft'), f('b', 'vessel')], remove: [] }).sort(), [
    'aircraft',
    'vessel',
  ]);
  assert.deepEqual(model.takeDirty().sort(), ['aircraft', 'vessel']);
  assert.deepEqual(model.takeDirty(), []);
  assert.deepEqual(model.apply({ upsert: [f('a', 'aircraft', 1)], remove: [] }), ['aircraft']);
  assert.equal(model.collection('aircraft').features[0]!.geometry.coordinates[1], 1);
  assert.deepEqual(model.apply({ upsert: [f('a', 'moved')], remove: ['b'] }).sort(), ['aircraft', 'moved', 'vessel']);
  assert.equal(model.collection('aircraft').features.length, 0);
  assert.equal(model.collection('vessel').features.length, 0);
  assert.equal(model.layerFor('a'), 'moved');
  model.apply({ upsert: [f('m1', 'moved'), f('m2', 'moved')], remove: [] });
  model.takeDirty();
  assert.deepEqual(model.apply({ upsert: [f('m1', 'moved')], remove: [], replaceLayers: ['moved'] }), ['moved']);
  assert.deepEqual(
    model.collection('moved').features.map((x) => x.properties.id),
    ['m1'],
  );
  assert.equal(model.size, 1);
  assert.equal(model.restyle({ ...f('m1', 'moved'), style: { styleClass: 'moved', selected: true } }), true);
  assert.equal(model.collection('moved').features[0]!.properties.selected, true);
  assert.deepEqual(model.clear(), ['aircraft', 'vessel', 'moved']);
  assert.equal(model.size, 0);
});

test('picking: overlay features resolve to PickResults, MapLibre clusters to synthetic ids, non-interactive skipped', () => {
  const base = {
    layer: { id: 'wv:aircraft:symbol' },
    source: 'wv:aircraft',
    geometry: { type: 'Point', coordinates: [20, 10, 500] },
  };
  const r = toPickResult(
    [{ ...base, properties: { id: 'obj:a', objectId: 'a', interactive: true } }],
    { x: 1, y: 2 },
    { lng: 0, lat: 0 },
  )!;
  assert.deepEqual(r, {
    featureId: 'obj:a',
    objectId: 'a',
    position: { latitude: 10, longitude: 20, altitudeM: 500 },
    screen: { x: 1, y: 2 },
  });
  assert.equal(
    toPickResult([{ ...base, properties: { id: 'obj:n', interactive: false } }], { x: 1, y: 2 }, { lng: 0, lat: 0 }),
    null,
  );
  assert.equal(
    toPickResult([{ ...base, source: 'basemap', properties: { id: 'x' } }], { x: 1, y: 2 }, { lng: 0, lat: 0 }),
    null,
    'basemap features are not picks',
  );
  const cluster = toPickResult(
    [{ ...base, properties: { cluster: true, cluster_id: 42, point_count: 7 } }],
    { x: 1, y: 2 },
    { lng: 5, lat: 6 },
  )!;
  assert.equal(cluster.featureId, 'mlcluster:aircraft:42');
  assert.equal(cluster.objectId, undefined);
  const poly = toPickResult(
    [{ ...base, geometry: { type: 'Polygon', coordinates: [] }, properties: { id: 'event:z', eventId: 'z' } }],
    { x: 1, y: 2 },
    { lng: 5, lat: 6 },
  )!;
  assert.deepEqual(poly.position, { latitude: 6, longitude: 5 });
  assert.equal(poly.eventId, 'z');
});

test('view: map ↔ ViewState round trip with pitch convention and altitude coupling', () => {
  const v = mapToViewState({ lng: 2.35, lat: 48.85, zoom: 11, bearing: -30, pitch: 45 });
  assert.equal(v.headingDegrees, 330);
  assert.equal(v.pitchDegrees, -45);
  assert.equal(v.altitudeM, zoomToAltitudeM(11, 48.85));
  const back = viewStateToMap(v, v);
  assert.deepEqual(back, { center: [2.35, 48.85], zoom: 11, bearing: 330, pitch: 45 });
  assert.equal(pitchDegreesToMapLibre(-90), 0);
  assert.equal(pitchDegreesToMapLibre(10), 85, 'clamped to MapLibre maximum');
  const fromAlt = viewStateToMap({ altitudeM: zoomToAltitudeM(5, 48.85) }, v);
  assert.ok(Math.abs(fromAlt.zoom - 5) < 1e-9);
  assert.deepEqual(
    resolveMapFlyTarget(
      { position: { latitude: 1, longitude: 2 }, bounds: { west: 0, south: 0, east: 1, north: 1 } },
      v,
    ),
    { kind: 'bounds', bounds: [0, 0, 1, 1] },
  );
  assert.deepEqual(resolveMapFlyTarget({ position: { latitude: 1, longitude: 2 }, zoom: 30 }, v), {
    kind: 'center',
    center: [2, 1],
    zoom: 22,
  });
  assert.equal(
    (resolveMapFlyTarget({ position: { latitude: 1, longitude: 2 } }, { ...v, zoom: 3 }) as { zoom: number }).zoom,
    10,
    'default fly zoom',
  );
});

test('attribution markup, pmtiles protocol registration and icon registry', () => {
  const markup = attributionMarkup([
    { id: 'b', text: 'Data <B>', onScreen: false },
    { id: 'a', text: 'Esri', url: 'https://www.esri.com', onScreen: true },
    { id: 'dup', text: 'Data <B>', onScreen: false },
  ]);
  assert.deepEqual(markup, [
    '<a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>',
    'Data &lt;B&gt;',
  ]);

  const ml = createFakeMapLibre();
  const pm = createFakePmtiles();
  assert.equal(ensurePmtilesProtocol(ml, pm).registeredNow, true);
  assert.equal(ensurePmtilesProtocol(ml, pm).registeredNow, false, 'registered once per module');
  assert.equal(pm.instances, 1);
  assert.ok(ml.protocols.has('pmtiles'));
  assert.equal(removePmtilesProtocol(ml), true);
  assert.equal(ml.protocols.has('pmtiles'), false);
  assert.equal(pmtilesSourceUrl('packs/a.pmtiles'), 'pmtiles://packs/a.pmtiles');
  assert.equal(pmtilesSourceUrl('pmtiles://x'), 'pmtiles://x');

  const map = new FakeMap({ container: {} as HTMLElement, style: buildEmptyStyle() });
  const icons = new IconRegistry(fakeImageCanvasFactory(), 16);
  const id = icons.ensure(map, 'aircraft', 'rgba(1,2,3,1.000)');
  assert.equal(id, 'wv-icon:aircraft:rgba(1,2,3,1.000)');
  assert.deepEqual(parseIconImageId(id), { icon: 'aircraft', colorCss: 'rgba(1,2,3,1.000)' });
  icons.ensure(map, 'aircraft', 'rgba(1,2,3,1.000)');
  assert.equal(icons.size, 1);
  assert.equal(map.images.get(id)!.data.length, 16 * 16 * 4);
  map.images.clear();
  assert.equal(icons.reapply(map), 1);
});
