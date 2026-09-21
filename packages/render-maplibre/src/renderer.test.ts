import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type PickResult, type RenderFeature } from '@worldview/render-core';
import { MapLibreWorldRenderer } from './renderer.js';
import { createFakeMapLibre, createFakePmtiles, fakeImageCanvasFactory, type FakeMapLibre } from './testing/fake-maplibre.js';
import { adaptMapLibreModule, adaptPmtilesModule, type MapLibreModule, type PmtilesModule } from './maplibre-module.js';
import type { MapStyle } from './styles/spec.js';

const styleName = (style: MapStyle | string): string => (typeof style === 'string' ? style : style.name);
const pt = (id: string, lat: number, lon: number, style: RenderFeature['style'] = { styleClass: 'aircraft' }, extra: Partial<RenderFeature> = {}): RenderFeature => ({ id, objectId: id.replace(/^obj:/, ''), geometry: { kind: 'point', position: { latitude: lat, longitude: lon } }, style, interactive: true, priority: 50, layer: 'aircraft', ...extra });

async function mounted(opts: { maplibre?: FakeMapLibre; withPmtiles?: boolean } = {}) {
  const maplibre = opts.maplibre ?? createFakeMapLibre();
  const pmtiles = createFakePmtiles();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({ maplibre, ...(opts.withPmtiles === false ? {} : { pmtiles }), createCanvas: fakeImageCanvasFactory(), scheduler, now: () => scheduler.now() });
  const events: Array<{ type: string; payload: unknown }> = [];
  for (const type of ['ready', 'viewChanged', 'pick', 'hover', 'error', 'frame'] as const) renderer.on(type, (payload) => events.push({ type, payload }));
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  return { maplibre, pmtiles, renderer, scheduler, events, map };
}

test('MapLibreWorldRenderer: mounts with a dark empty style, no default attribution control and a preserved drawing buffer', async () => {
  const { renderer, map, events } = await mounted();
  assert.equal(map.options.attributionControl, false);
  assert.equal(map.options.preserveDrawingBuffer, true);
  assert.equal(map.options.canvasContextAttributes?.preserveDrawingBuffer, true);
  assert.equal(map.options.maxPitch, 85);
  assert.equal(styleName(map.style), 'empty-dark');
  assert.ok(events.some((e) => e.type === 'ready'));
  assert.deepEqual(renderer.capabilities, { mode: '2D', terrain: false, tilt: true, clustering: true, maxFeatures: 200_000 });
  renderer.dispose();
  assert.equal(map.removed, true);
});

test('MapLibreWorldRenderer: updates diff into per-layer GeoJSON sources, batched to one setData per layer per frame, with icons registered', async () => {
  const { renderer, map, scheduler } = await mounted();
  renderer.update({ upsert: [pt('obj:a', 10, 20, { styleClass: 'aircraft', icon: 'aircraft', label: 'UAL1', rotationDegrees: 90 }), pt('obj:b', 11, 21)], remove: [] });
  renderer.update({ upsert: [pt('obj:c', 12, 22, { styleClass: 'vessel' }, { layer: 'vessel' })], remove: [] });
  assert.equal(map.sources.size, 0, 'nothing pushed before the frame');
  scheduler.flush();
  assert.deepEqual([...map.sources.keys()].sort(), ['wv:aircraft', 'wv:vessel']);
  const aircraft = map.getSource('wv:aircraft')!;
  assert.equal(aircraft.setDataCalls, 1, 'two updates coalesced into one setData');
  assert.equal(aircraft.data.features.length, 2);
  assert.equal(aircraft.spec.type === 'geojson' && aircraft.spec.cluster, true, 'aircraft layer clusters (clusterPx from rules)');
  assert.equal(map.getSource('wv:vessel')!.data.features.length, 1);
  assert.equal(map.layers.filter((l) => l.id.startsWith('wv:aircraft:')).length, 10);
  assert.ok(map.layers.some((l) => l.id === 'wv:aircraft:symbol'));
  const iconId = aircraft.data.features.find((f) => f.properties.id === 'obj:a')!.properties.icon!;
  assert.ok(map.hasImage(iconId), 'icon image registered for the feature colour');

  // Move + remove: only the aircraft source is touched again.
  renderer.update({ upsert: [pt('obj:a', 10.5, 20.5, { styleClass: 'aircraft', icon: 'aircraft' })], remove: ['obj:b'] });
  scheduler.flush();
  assert.equal(aircraft.setDataCalls, 2);
  assert.equal(map.getSource('wv:vessel')!.setDataCalls, 1);
  assert.deepEqual(aircraft.data.features.map((f) => f.properties.id), ['obj:a']);
  assert.equal(aircraft.data.features[0]!.geometry.coordinates[1], 10.5);
  assert.equal(renderer.featureCount, 2);

  renderer.clear('vessel');
  scheduler.flush();
  assert.equal(map.getSource('wv:vessel')!.data.features.length, 0);
  renderer.clear();
  scheduler.flush();
  assert.equal(aircraft.data.features.length, 0);
  assert.equal(renderer.featureCount, 0);
  renderer.dispose();
});

test('MapLibreWorldRenderer: selection restyles, picks and frame-throttled hover through queryRenderedFeatures', async () => {
  const { renderer, map, scheduler, events } = await mounted();
  renderer.update({ upsert: [pt('obj:a', 10, 20, { styleClass: 'aircraft', size: 10 }), pt('obj:b', 11, 21, { styleClass: 'aircraft', size: 10 })], remove: [] });
  scheduler.flush();
  const src = map.getSource('wv:aircraft')!;
  const feat = (id: string) => src.data.features.find((f) => f.properties.id === id)!;
  renderer.select('obj:a');
  scheduler.flush();
  assert.equal(feat('obj:a').properties.selected, true);
  assert.equal(feat('obj:a').properties.size, 12.5);
  renderer.select('obj:b');
  scheduler.flush();
  assert.equal(feat('obj:a').properties.selected, false);
  assert.equal(feat('obj:b').properties.selected, true);
  renderer.update({ upsert: [pt('obj:b', 11.5, 21.5, { styleClass: 'aircraft', size: 10 })], remove: [] });
  scheduler.flush();
  assert.equal(feat('obj:b').properties.selected, true, 'selection survives a data update');

  map.queryResults = [{ layer: { id: 'wv:aircraft:circle' }, source: 'wv:aircraft', geometry: { type: 'Point', coordinates: [20, 10] }, properties: { id: 'obj:a', objectId: 'a', interactive: true } }];
  map.fire('click', { point: { x: 3, y: 4 }, lngLat: { lng: 20, lat: 10 } });
  const pick = events.find((e) => e.type === 'pick')!.payload as PickResult;
  assert.equal(pick.featureId, 'obj:a');
  assert.equal(pick.objectId, 'a');
  assert.deepEqual(pick.screen, { x: 3, y: 4 });
  assert.ok(map.queries.at(-1)!.layers!.includes('wv:aircraft:circle'), 'only interactive overlay layers are queried');
  assert.ok(!map.queries.at(-1)!.layers!.includes('wv:aircraft:density'));

  map.fire('mousemove', { point: { x: 3, y: 4 }, lngLat: { lng: 20, lat: 10 } });
  map.fire('mousemove', { point: { x: 4, y: 5 }, lngLat: { lng: 20, lat: 10 } });
  assert.equal(events.filter((e) => e.type === 'hover').length, 0);
  scheduler.flush();
  assert.equal(events.filter((e) => e.type === 'hover').length, 1);
  map.fire('mouseout', {});
  assert.equal(events.filter((e) => e.type === 'hover').at(-1)!.payload, null);
  renderer.dispose();
});

test('MapLibreWorldRenderer: view state round trip, flyTo/fitBounds, suspend stops the map and defers flushes', async () => {
  const { renderer, map, scheduler, events } = await mounted();
  renderer.setView({ center: { latitude: 48.85, longitude: 2.35 }, zoom: 11, headingDegrees: 30, pitchDegrees: -60 });
  const v = renderer.getView();
  assert.deepEqual(v.center, { latitude: 48.85, longitude: 2.35 });
  assert.equal(v.zoom, 11);
  assert.equal(v.headingDegrees, 30);
  assert.equal(v.pitchDegrees, -60);
  assert.ok(v.bounds && v.bounds.west < 2.35 && v.bounds.east > 2.35);
  scheduler.flush();
  assert.ok(events.some((e) => e.type === 'viewChanged'));
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, zoom: 9 });
  assert.equal(map.zoom, 9);
  assert.deepEqual(map.center, { lng: 2, lat: 1 });
  await renderer.flyTo({ position: { latitude: 0, longitude: 0 }, bounds: { west: -10, south: -5, east: 10, north: 5 } });
  assert.deepEqual(map.center, { lng: 0, lat: 0 });
  assert.ok(map.zoom > 3 && map.zoom < 6);

  renderer.suspend();
  assert.equal(map.stops, 1);
  renderer.update({ upsert: [pt('obj:s', 0, 0)], remove: [] });
  scheduler.flush();
  assert.equal(map.sources.has('wv:aircraft'), false, 'no source work while suspended');
  renderer.resume();
  scheduler.flush();
  assert.equal(map.getSource('wv:aircraft')!.data.features.length, 1);
  renderer.dispose();
});

test('MapLibreWorldRenderer: basemap descriptors swap the style and overlays survive; pmtiles registers the protocol; attribution control follows entries', async () => {
  const { renderer, map, scheduler, maplibre, events } = await mounted();
  renderer.update({ upsert: [pt('obj:a', 10, 20, { styleClass: 'aircraft', icon: 'aircraft' })], remove: [] });
  scheduler.flush();
  await renderer.setBasemap({ kind: 'pmtiles', id: 'pack', url: 'packs/europe.pmtiles', styleId: 'worldview-dark', attribution: '© OpenStreetMap contributors' });
  assert.ok(maplibre.protocols.has('pmtiles'));
  const style = map.style as MapStyle;
  assert.equal(style.name, 'worldview-dark');
  assert.equal(style.sources['basemap']?.type === 'vector' && style.sources['basemap'].url, 'pmtiles://packs/europe.pmtiles');
  assert.ok(map.sources.has('wv:aircraft'), 'overlay source re-added after the style change');
  assert.equal(map.getSource('wv:aircraft')!.data.features.length, 1);
  assert.equal(map.images.size, 1, 'icon images re-registered');

  await renderer.setBasemap({ kind: 'raster-xyz', id: 'custom', url: 'https://tiles.example/{z}/{x}/{y}.png', attribution: 'Example', maxZoom: 12 });
  assert.equal(styleName(map.style), 'raster-custom');
  await renderer.setBasemap({ kind: 'vector-style', id: 'ofm', styleUrl: 'https://tiles.openfreemap.org/styles/dark', attribution: 'OpenFreeMap' });
  assert.equal(styleName(map.style), 'https://tiles.openfreemap.org/styles/dark');
  await renderer.setBasemap({ kind: 'cesium-natural-earth', id: 'ne', attribution: '' });
  assert.match((events.filter((e) => e.type === 'error').at(-1)!.payload as { message: string }).message, /globe-only/);
  assert.equal(styleName(map.style), 'empty-dark');

  renderer.setAttribution([{ id: 'usgs', text: 'USGS', onScreen: false }]);
  assert.equal(map.controls.length, 1);
  renderer.setAttribution([{ id: 'usgs', text: 'USGS', onScreen: false }]);
  assert.equal(map.controls.length, 1, 'unchanged entries do not rebuild the control');
  renderer.setAttribution([]);
  assert.equal(map.controls.length, 1);
  renderer.dispose();
  assert.equal(map.controls.length, 0);

  const noPm = await mounted({ withPmtiles: false });
  await assert.rejects(noPm.renderer.setBasemap({ kind: 'pmtiles', id: 'p', url: 'x', styleId: 'worldview-dark', attribution: '' }), /pmtiles module/);
  noPm.renderer.dispose();
});

// ── real modules ──────────────────────────────────────────────────────────────
let mapLibreModule: MapLibreModule | undefined;
let pmtilesModule: PmtilesModule | undefined;
let skipReason: string | false = false;
try {
  [mapLibreModule, pmtilesModule] = await Promise.all([import('maplibre-gl'), import('pmtiles')]);
} catch (err) {
  skipReason = `maplibre-gl / pmtiles not installed in this environment (no registry access): ${(err as Error).message.split('\n')[0]} — verify on the operator machine`;
}

test('MapLibreWorldRenderer: the real maplibre-gl and pmtiles modules expose the members the adapter relies on', { skip: skipReason }, () => {
  const ml = adaptMapLibreModule(mapLibreModule!);
  const pm = adaptPmtilesModule(pmtilesModule!);
  assert.equal(typeof ml.Map, 'function');
  assert.equal(typeof ml.AttributionControl, 'function');
  assert.equal(typeof ml.addProtocol, 'function');
  assert.equal(typeof new pm.Protocol().tile, 'function');
});

test('MapLibreWorldRenderer: constructs a Map against a real WebGL canvas', { skip: skipReason || 'needs a browser/Electron renderer with WebGL (no DOM in node:test); covered by the desktop smoke test' }, () => {
  assert.fail('unreachable');
});
