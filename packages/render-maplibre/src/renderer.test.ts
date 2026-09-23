import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type PickResult, type RenderFeature } from '@worldview/render-core';
import { MapLibreWorldRenderer } from './renderer.js';
import {
  createFakeMapLibre,
  createFakePmtiles,
  fakeImageCanvasFactory,
  type FakeMapLibre,
} from './testing/fake-maplibre.js';
import { adaptMapLibreModule, adaptPmtilesModule, type MapLibreModule, type PmtilesModule } from './maplibre-module.js';
import type { MapStyle } from './styles/spec.js';

const styleName = (style: MapStyle | string): string => (typeof style === 'string' ? style : style.name);
const pt = (
  id: string,
  lat: number,
  lon: number,
  style: RenderFeature['style'] = { styleClass: 'aircraft' },
  extra: Partial<RenderFeature> = {},
): RenderFeature => ({
  id,
  objectId: id.replace(/^obj:/, ''),
  geometry: { kind: 'point', position: { latitude: lat, longitude: lon } },
  style,
  interactive: true,
  priority: 50,
  layer: 'aircraft',
  ...extra,
});

async function mounted(
  opts: {
    maplibre?: FakeMapLibre;
    withPmtiles?: boolean;
    styleLoadTimeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
  } = {},
) {
  const maplibre = opts.maplibre ?? createFakeMapLibre();
  const pmtiles = createFakePmtiles();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    ...(opts.withPmtiles === false ? {} : { pmtiles }),
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    ...(opts.styleLoadTimeoutMs === undefined ? {} : { styleLoadTimeoutMs: opts.styleLoadTimeoutMs }),
    ...(opts.setTimer ? { setTimer: opts.setTimer, clearTimer: () => undefined } : {}),
  });
  const events: Array<{ type: string; payload: unknown }> = [];
  for (const type of ['ready', 'viewChanged', 'pick', 'hover', 'error', 'frame'] as const)
    renderer.on(type, (payload) => events.push({ type, payload }));
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
  assert.deepEqual(renderer.capabilities, {
    mode: '2D',
    terrain: false,
    tilt: true,
    clustering: true,
    maxFeatures: 200_000,
  });
  renderer.dispose();
  assert.equal(map.removed, true);
});

test('MapLibreWorldRenderer: with attribution by the host, no control is added to the map', async () => {
  const maplibre = createFakeMapLibre();
  const scheduler = new ManualScheduler();
  const renderer = new MapLibreWorldRenderer({
    maplibre,
    createCanvas: fakeImageCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    attribution: 'host',
  });
  await renderer.mount({} as HTMLElement);
  const map = maplibre.maps[0]!;
  renderer.setAttribution([]);
  renderer.setAttribution([{ id: 'usgs', text: 'USGS', onScreen: true }]);
  assert.equal(map.controls.length, 0, 'the shell draws the credit line; no second strip on the map');
  renderer.dispose();

  const { renderer: byMap, map: withControl } = await mounted();
  byMap.setAttribution([{ id: 'usgs', text: 'USGS', onScreen: true }]);
  assert.equal(withControl.controls.length, 1, 'the default still credits on the map');
  byMap.dispose();
});

test('MapLibreWorldRenderer: updates diff into per-layer GeoJSON sources, batched to one setData per layer per frame, with icons registered', async () => {
  const { renderer, map, scheduler } = await mounted();
  renderer.update({
    upsert: [
      pt('obj:a', 10, 20, { styleClass: 'aircraft', icon: 'aircraft', label: 'UAL1', rotationDegrees: 90 }),
      pt('obj:b', 11, 21),
    ],
    remove: [],
  });
  renderer.update({ upsert: [pt('obj:c', 12, 22, { styleClass: 'vessel' }, { layer: 'vessel' })], remove: [] });
  assert.equal(map.sources.size, 0, 'nothing pushed before the frame');
  scheduler.flush();
  assert.deepEqual([...map.sources.keys()].sort(), ['wv:aircraft', 'wv:vessel']);
  const aircraft = map.getSource('wv:aircraft')!;
  assert.equal(aircraft.setDataCalls, 1, 'two updates coalesced into one setData');
  assert.equal(aircraft.data.features.length, 2);
  assert.notEqual(
    aircraft.spec.type === 'geojson' && aircraft.spec.cluster,
    true,
    'aircraft are not clustered: every one is its own dot',
  );
  assert.equal(map.getSource('wv:vessel')!.data.features.length, 1);
  assert.equal(map.layers.filter((l) => l.id.startsWith('wv:aircraft:')).length, 10);
  assert.ok(map.layers.some((l) => l.id === 'wv:aircraft:symbol'));
  const iconId = aircraft.data.features.find((f) => f.properties.id === 'obj:a')!.properties.icon!;
  assert.ok(map.hasImage(iconId), 'icon image registered for the feature colour');

  // Move + remove: only the aircraft source is touched again.
  renderer.update({
    upsert: [pt('obj:a', 10.5, 20.5, { styleClass: 'aircraft', icon: 'aircraft' })],
    remove: ['obj:b'],
  });
  scheduler.flush();
  assert.equal(aircraft.setDataCalls, 2);
  assert.equal(map.getSource('wv:vessel')!.setDataCalls, 1);
  assert.deepEqual(
    aircraft.data.features.map((f) => f.properties.id),
    ['obj:a'],
  );
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
  renderer.update({
    upsert: [
      pt('obj:a', 10, 20, { styleClass: 'aircraft', size: 10 }),
      pt('obj:b', 11, 21, { styleClass: 'aircraft', size: 10 }),
    ],
    remove: [],
  });
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

  map.queryResults = [
    {
      layer: { id: 'wv:aircraft:circle' },
      source: 'wv:aircraft',
      geometry: { type: 'Point', coordinates: [20, 10] },
      properties: { id: 'obj:a', objectId: 'a', interactive: true },
    },
  ];
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

test('MapLibreWorldRenderer: no hover queries while the map moves; the resting target resolves at moveend', async () => {
  const { renderer, map, scheduler, events } = await mounted();
  renderer.update({ upsert: [pt('obj:a', 10, 20, { styleClass: 'aircraft', size: 10 })], remove: [] });
  scheduler.flush();
  const hit = (id: string) => [
    {
      layer: { id: 'wv:aircraft:circle' },
      source: 'wv:aircraft',
      geometry: { type: 'Point', coordinates: [20, 10] },
      properties: { id, objectId: id.slice(4), interactive: true },
    },
  ];
  const hovers = () => events.filter((e) => e.type === 'hover');
  const queriesBefore = map.queries.length;

  map.fire('movestart', {});
  for (const x of [3, 30, 60]) {
    map.queryResults = hit(x === 30 ? 'obj:b' : 'obj:a');
    map.fire('mousemove', { point: { x, y: 4 }, lngLat: { lng: 20, lat: 10 } });
    scheduler.flush();
  }
  assert.equal(map.queries.length, queriesBefore, 'a pan sweeps the cursor across dots without querying any of them');
  assert.equal(hovers().length, 0);

  map.queryResults = hit('obj:a');
  map.fire('moveend', {});
  scheduler.flush();
  assert.equal(map.queries.length, queriesBefore + 1, 'one query, where the pointer came to rest');
  assert.equal((hovers().at(-1)!.payload as PickResult).featureId, 'obj:a');
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
  await renderer.flyTo({
    position: { latitude: 0, longitude: 0 },
    bounds: { west: -10, south: -5, east: 10, north: 5 },
  });
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
  await renderer.setBasemap({
    kind: 'pmtiles',
    id: 'pack',
    url: 'packs/europe.pmtiles',
    styleId: 'worldview-dark',
    attribution: '© OpenStreetMap contributors',
  });
  assert.ok(maplibre.protocols.has('pmtiles'));
  const style = map.style as MapStyle;
  assert.equal(style.name, 'worldview-dark');
  assert.equal(
    style.sources['basemap']?.type === 'vector' && style.sources['basemap'].url,
    'pmtiles://packs/europe.pmtiles',
  );
  assert.ok(map.sources.has('wv:aircraft'), 'overlay source re-added after the style change');
  assert.equal(map.getSource('wv:aircraft')!.data.features.length, 1);
  assert.equal(map.images.size, 1, 'icon images re-registered');

  await renderer.setBasemap({
    kind: 'raster-xyz',
    id: 'custom',
    url: 'https://tiles.example/{z}/{x}/{y}.png',
    attribution: 'Example',
    maxZoom: 12,
  });
  assert.equal(styleName(map.style), 'raster-custom');
  await renderer.setBasemap({
    kind: 'vector-style',
    id: 'ofm',
    styleUrl: 'https://tiles.openfreemap.org/styles/dark',
    attribution: 'OpenFreeMap',
  });
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
  await assert.rejects(
    noPm.renderer.setBasemap({ kind: 'pmtiles', id: 'p', url: 'x', styleId: 'worldview-dark', attribution: '' }),
    /pmtiles module/,
  );
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

test(
  'MapLibreWorldRenderer: the real maplibre-gl and pmtiles modules expose the members the adapter relies on',
  { skip: skipReason },
  () => {
    const ml = adaptMapLibreModule(mapLibreModule!);
    const pm = adaptPmtilesModule(pmtilesModule!);
    // Named so a failure says which member is missing rather than "expected function".
    for (const [name, value] of [
      ['Map', ml.Map],
      ['AttributionControl', ml.AttributionControl],
      ['addProtocol', ml.addProtocol],
    ] as const) {
      assert.equal(typeof value, 'function', `maplibre-gl does not expose ${name} where the adapter reads it`);
    }
    assert.equal(
      typeof new pm.Protocol().tile,
      'function',
      'pmtiles does not expose Protocol#tile where the adapter reads it',
    );

    // The interop itself: these live on the module's default export, not the namespace,
    // so reading the namespace directly is the mistake this guards against.
    const raw = mapLibreModule as { default?: Record<string, unknown> };
    if (raw.default) {
      assert.equal(
        typeof raw.default['AttributionControl'],
        'function',
        'the default export is where maplibre-gl keeps its members',
      );
    }
  },
);

test(
  'MapLibreWorldRenderer: constructs a Map against a real WebGL canvas',
  {
    skip:
      skipReason ||
      'needs a browser/Electron renderer with WebGL (no DOM in node:test); covered by the desktop smoke test',
  },
  () => {
    assert.fail('unreachable');
  },
);

/**
 * `setBasemap` awaited `style.load` with nothing to stop it waiting forever.
 *
 * `style.load` does not fire when the style cannot be built, and the ordinary way to
 * reach that is the default 2D basemap on a fresh installation: a pmtiles pack that is
 * not installed. The promise never settled, and because the host awaited it before
 * pushing features, the 2D map came up with no backdrop and no objects at all — which
 * reads as a dead renderer rather than a missing file.
 */
test('MapLibreWorldRenderer: a style that never loads gives up and says so, instead of hanging', async () => {
  const fired: Array<() => void> = [];
  const { renderer, map, events } = await mounted({
    styleLoadTimeoutMs: 250,
    setTimer: (fn) => {
      fired.push(fn);
      return fired.length;
    },
  });

  // A style that never announces itself — the fake normally fires style.load inside setStyle.
  map.setStyle = () => undefined;

  let settled = false;
  const pending = renderer
    .setBasemap({
      kind: 'pmtiles',
      id: 'pack',
      url: 'packs/absent.pmtiles',
      styleId: 'worldview-dark',
      attribution: '',
    })
    .then(() => {
      settled = true;
    });

  await new Promise(setImmediate);
  assert.equal(settled, false, 'it waits for the style first');

  assert.equal(fired.length, 1, 'a bound wait was armed');
  fired[0]!();
  await pending;

  assert.equal(settled, true, 'the promise settles rather than stranding every caller behind it');
  const errors = events.filter((e) => e.type === 'error').map((e) => e.payload as { message: string; fatal: boolean });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /did not finish loading within 250 ms/);
  assert.equal(errors[0]!.fatal, false, 'a missing backdrop is not fatal to the map');
  renderer.dispose();
});

test('MapLibreWorldRenderer: one moving aircraft is a diff, not a re-index of every aircraft', async () => {
  // `setData` makes MapLibre re-index every feature of the source in its worker. With the
  // whole fleet in one layer, a single position report used to re-tile all of it — the 2D
  // "buffering" while data streamed in. A layer the map already holds now gets a diff.
  const { renderer, map, scheduler } = await mounted();
  const fleet = Array.from({ length: 200 }, (_, i) => pt(`obj:ac${i}`, 10 + i * 0.01, 20));
  renderer.update({ upsert: fleet, remove: [] });
  scheduler.flush();
  const source = map.getSource('wv:aircraft')!;
  assert.equal(source.setDataCalls, 1, 'the first push is whole: the source did not exist');
  assert.equal(source.updateDataCalls, 0);

  renderer.update({ upsert: [pt('obj:ac7', 45, 45)], remove: ['obj:ac8'] });
  scheduler.flush();
  assert.equal(source.setDataCalls, 1, 'no second full push');
  assert.equal(source.updateDataCalls, 1, 'one diff');
  assert.equal(source.data.features.length, 199, 'ac8 removed');
  const moved = source.data.features.find((f) => f.id === 'obj:ac7')!;
  assert.deepEqual(moved.geometry.coordinates, [45, 45], 'ac7 moved');
  assert.equal(new Set(source.data.features.map((f) => f.id)).size, 199, 'a replacement is not a duplicate');

  // A change touching most of the layer is cheaper as one full push.
  renderer.update({ upsert: fleet.slice(0, 150).map((f) => ({ ...f, priority: 51 })), remove: [] });
  scheduler.flush();
  assert.equal(source.setDataCalls, 2, 'a bulk change goes whole');
});

test('MapLibreWorldRenderer: a source that refuses a diff is replaced whole, and says so once', async () => {
  // A layer that silently stopped updating would be worse than a slow one, so a refused diff
  // falls back to `setData` for that layer from then on, with one non-fatal error.
  const { renderer, map, scheduler } = await mounted();
  const errors: string[] = [];
  renderer.on('error', (e) => errors.push(e.message));
  const fleet = Array.from({ length: 50 }, (_, i) => pt(`obj:ac${i}`, 10 + i * 0.01, 20));
  renderer.update({ upsert: fleet, remove: [] });
  scheduler.flush();
  const source = map.getSource('wv:aircraft')!;
  source.refuseDiffs = true;

  renderer.update({ upsert: [pt('obj:ac1', 30, 30)], remove: [] });
  scheduler.flush();
  assert.equal(source.setDataCalls, 2, 'fell back to a full push');
  assert.deepEqual(
    source.data.features.find((f) => f.id === 'obj:ac1')!.geometry.coordinates,
    [30, 30],
    'and the change still landed',
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /incremental update refused/);

  renderer.update({ upsert: [pt('obj:ac2', 31, 31)], remove: [] });
  scheduler.flush();
  assert.equal(source.setDataCalls, 3, 'stays on full pushes');
  assert.equal(errors.length, 1, 'without repeating the error');
});

test('MapLibreWorldRenderer: an idle map is not a slow map', async () => {
  // MapLibre draws only when something changes. Dividing frames by wall-clock time turned a
  // map left alone for thirty seconds into a 0.03 fps sample, and the performance governor
  // stepped detail down on a machine that was doing nothing. Only continuous rendering counts.
  const { map, scheduler, events } = await mounted();
  const fps = () => events.filter((e) => e.type === 'frame').map((e) => (e.payload as { fps: number }).fps);
  const render = (count: number, everyMs: number) => {
    for (let i = 0; i < count; i++) {
      scheduler.flush(everyMs);
      map.fire('render', {});
    }
  };
  render(70, 16); // a second of smooth drawing
  assert.equal(fps().length, 1);
  assert.ok(fps()[0]! >= 55, `smooth drawing reads as smooth: ${fps()[0]}`);

  scheduler.flush(30_000); // left alone
  render(1, 16);
  render(3, 16);
  assert.equal(fps().length, 1, 'thirty idle seconds and a few frames are not a measurement');

  render(60, 50); // genuinely slow: 20 fps while drawing
  // The first slow window still carries a few leftover smooth frames; by the next one the
  // measurement is the slow drawing alone.
  assert.ok(fps().length >= 3, `rendering time keeps producing samples: ${fps().join(', ')}`);
  const last = fps().at(-1)!;
  assert.ok(last <= 21 && last >= 18, `slow drawing still reads as slow: ${last}`);
  assert.ok(Math.min(...fps()) >= 18, `and nothing near the 0.03 fps an idle gap used to produce: ${fps().join(', ')}`);
  const longest = events
    .filter((e) => e.type === 'frame')
    .map((e) => (e.payload as { maxFrameMs?: number }).maxFrameMs);
  assert.equal(longest[0], 16, 'the longest frame of a smooth second');
  assert.equal(longest.at(-1), 50, 'and of a slow one — an idle gap never counts as a frame');
});
