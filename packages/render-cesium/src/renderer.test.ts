import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type PickResult, type RenderFeature } from '@worldview/render-core';
import { CesiumWorldRenderer } from './renderer.js';
import {
  createFakeCesium,
  fakeCanvasFactory,
  fakeTerrainProvider,
  type FakeCesium,
  type FakeDataSource,
  type FakeViewer,
} from './testing/fake-cesium.js';
import { adaptCesiumModule, type CesiumModule } from './cesium-module.js';
import { NATURAL_EARTH_STACK_ID } from './basemaps.js';

const container = () =>
  ({
    ownerDocument: {
      createElement: () => ({
        className: '',
        remove() {
          /* noop */
        },
      }),
    },
    appendChild() {
      /* noop */
    },
    addEventListener() {
      /* noop */
    },
    removeEventListener() {
      /* noop */
    },
  }) as unknown as HTMLElement;
const pt = (
  id: string,
  lat: number,
  lon: number,
  style: RenderFeature['style'] = { styleClass: 'aircraft' },
  extra: Partial<RenderFeature> = {},
): RenderFeature => ({
  id,
  objectId: id.replace(/^obj:/, ''),
  geometry: { kind: 'point', position: { latitude: lat, longitude: lon, altitudeM: 9000 } },
  style,
  interactive: true,
  priority: 50,
  layer: 'aircraft',
  ...extra,
});

async function mounted(opts: { cesium?: FakeCesium } = {}) {
  const cesium = opts.cesium ?? createFakeCesium();
  const scheduler = new ManualScheduler();
  const renderer = new CesiumWorldRenderer({
    cesium,
    createCanvas: fakeCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
  });
  const events: Array<{ type: string; payload: unknown }> = [];
  for (const type of ['ready', 'viewChanged', 'pick', 'hover', 'error', 'frame'] as const)
    renderer.on(type, (payload) => events.push({ type, payload }));
  await renderer.mount(container());
  const viewer = cesium.viewers[0]!;
  return { cesium, renderer, scheduler, events, viewer };
}

/** Union of the fields the fake primitives expose; tests read whichever apply. */
interface PrimitiveItem {
  id: unknown;
  show?: boolean;
  position?: { x: number; y: number; z: number };
  rotation?: number;
  heightReference?: number;
  image?: string;
  color?: { red: number; green: number; blue: number };
  pixelSize?: number;
  outlineWidth?: number;
  text?: string;
  pixelOffset?: { y: number };
  material?: { type: string };
  width?: number;
}
function collections(viewer: FakeViewer): Array<{ items: PrimitiveItem[] }> {
  return viewer.scene.primitives.items as Array<{ items: PrimitiveItem[] }>;
}
function items(viewer: FakeViewer): PrimitiveItem[] {
  return collections(viewer).flatMap((c) => c.items);
}

test('CesiumWorldRenderer: mount creates a widget-free viewer with the globe shown and Natural Earth II active', async () => {
  const { renderer, viewer, events, cesium } = await mounted();
  assert.equal(viewer.options?.baseLayer, false, 'Cesium installs no base layer of its own');
  assert.equal(viewer.options?.msaaSamples, 4);
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(viewer.scene.skyAtmosphere.show, true);
  // The limb glow comes from the sky atmosphere; the *ground* atmosphere has to stay off
  // while lighting is off, or Cesium adds full-strength scattering to every pixel of the
  // globe and the basemap's colours stop being the basemap's colours.
  assert.equal(viewer.scene.globe.enableLighting, false);
  assert.equal(viewer.scene.globe.showGroundAtmosphere, false);
  // Tiles already fetched stay resident, and the neighbours of what is drawn are fetched
  // ahead of a pan — the two settings that stop the globe re-buffering ground it has shown.
  assert.ok(viewer.scene.globe.tileCacheSize > 100, 'more than Cesium keeps by default');
  assert.equal(viewer.scene.globe.preloadSiblings, true);
  assert.equal(viewer.imageryLayers.length, 1, 'default imagery layer added');
  assert.equal(renderer.basemapState?.activeId, NATURAL_EARTH_STACK_ID);
  assert.ok(events.some((e) => e.type === 'ready'));
  assert.deepEqual(renderer.capabilities, {
    mode: '3D',
    terrain: true,
    tilt: true,
    clustering: false,
    maxFeatures: 100_000,
  });
  assert.equal(cesium.handlers.length, 1);
  assert.ok(viewer.scene.screenSpaceCameraController.zoomEventTypes, 'trackpad pinch binding installed');
  renderer.dispose();
  assert.equal(viewer.isDestroyed(), true);
  assert.equal(cesium.handlers[0]!.destroyed, true);
  renderer.dispose();
});

test('CesiumWorldRenderer: features land in the right collections with height modes, theme colours and labels', async () => {
  const { renderer, viewer, scheduler } = await mounted();
  const icon = pt('obj:a', 10, 20, {
    styleClass: 'aircraft',
    icon: 'aircraft',
    label: 'UAL1',
    rotationDegrees: 90,
    heightMode: 'absolute',
  });
  const dot = pt('obj:b', 11, 21, { styleClass: 'vessel', heightMode: 'clamp' }, { layer: 'vessel' });
  const line: RenderFeature = {
    id: 'trail:a',
    geometry: {
      kind: 'line',
      positions: [
        { latitude: 10, longitude: 20, altitudeM: 9000 },
        { latitude: 10.1, longitude: 20.1, altitudeM: 9000 },
      ],
    },
    style: { styleClass: 'trail', lineStyle: 'trail', size: 2, heightMode: 'absolute' },
    interactive: false,
    priority: 90,
    layer: 'trail',
  };
  const polygon: RenderFeature = {
    id: 'event:z',
    eventId: 'z',
    geometry: {
      kind: 'polygon',
      rings: [
        [
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 1 },
          { latitude: 1, longitude: 1 },
        ],
      ],
    },
    style: { styleClass: 'event.weather-alert', label: 'Alert' },
    interactive: true,
    priority: 80,
    layer: 'events',
  };
  const circle: RenderFeature = {
    id: 'obj:c',
    objectId: 'c',
    geometry: { kind: 'circle', center: { latitude: 5, longitude: 5 }, radiusM: 2000 },
    style: { styleClass: 'earthquake' },
    interactive: true,
    priority: 70,
    layer: 'earthquake',
  };
  const density: RenderFeature = {
    id: 'density:fire:1:1',
    geometry: { kind: 'density', bounds: { west: 0, south: 0, east: 5, north: 5 }, count: 12, intensity: 0.5 },
    style: { styleClass: 'fire.density' },
    interactive: false,
    priority: 40,
    layer: 'fire.density',
  };
  const cluster: RenderFeature = {
    id: 'cluster:vessel:1',
    geometry: {
      kind: 'cluster',
      position: { latitude: 30, longitude: 30 },
      count: 17,
      bounds: { west: 29, south: 29, east: 31, north: 31 },
    },
    style: { styleClass: 'vessel.cluster', label: '17', size: 32 },
    interactive: true,
    priority: 30,
    layer: 'vessel.cluster',
  };
  renderer.update({ upsert: [icon, dot, line, polygon, circle, density, cluster], remove: [] });
  assert.equal(renderer.featureCount, 7);

  const glyphs = (id: string) => items(viewer).filter((i) => i.id === id && i.text === undefined);
  const billboards = glyphs('obj:a');
  assert.equal(billboards.length, 1);
  assert.deepEqual(billboards[0]!.position, { x: 20, y: 10, z: 9000 }, 'absolute height keeps the altitude');
  assert.equal(billboards[0]!.heightReference, 0);
  assert.ok(Math.abs(billboards[0]!.rotation! + Math.PI / 2) < 1e-9);
  assert.ok(billboards[0]!.image!.startsWith('data:image/png'));
  const dots = items(viewer).filter((i) => i.id === 'obj:b');
  assert.equal(dots[0]!.position!.z, 0, 'clamped point drawn at the surface');
  assert.equal(dots[0]!.pixelSize, 6);
  assert.ok(dots[0]!.color!.green > dots[0]!.color!.red, 'vessel teal from the theme');
  const labels = items(viewer).filter((i) => i.text !== undefined);
  assert.deepEqual(labels.map((l) => l.text).sort(), ['17', 'UAL1']);
  assert.equal(labels.find((l) => l.id === 'cluster:vessel:1')!.pixelOffset!.y, 0, 'cluster count centred');
  const polylines = items(viewer).filter((i) => i.id === 'trail:a');
  assert.equal(polylines[0]!.material!.type, 'PolylineDash');
  assert.equal(polylines[0]!.width, 2);
  const ds = viewer.dataSources.sources as FakeDataSource[];
  const eventDs = ds.find((d) => d.name === 'worldview:events')!;
  assert.ok(eventDs.entities.entities[0]!.options.polygon);
  const eqDs = ds.find((d) => d.name === 'worldview:earthquake')!;
  assert.ok(eqDs.entities.entities[0]!.options.ellipse);
  assert.equal(
    (viewer.scene.groundPrimitives.items[0] as { cells: unknown[] }).cells.length,
    1,
    'density cells batched in one ground primitive',
  );

  // Update in place: moving the icon keeps one billboard; removing drops it.
  renderer.update({
    upsert: [{ ...icon, geometry: { kind: 'point', position: { latitude: 12, longitude: 22, altitudeM: 9500 } } }],
    remove: ['obj:b'],
  });
  assert.equal(glyphs('obj:a').length, 1);
  assert.deepEqual(glyphs('obj:a')[0]!.position, { x: 22, y: 12, z: 9500 });
  assert.equal(items(viewer).filter((i) => i.id === 'obj:b').length, 0);
  assert.equal(renderer.featureCount, 6);

  // Declutter pass runs on the next frame and keeps non-overlapping labels visible.
  assert.equal(scheduler.pendingCount >= 1, true);
  scheduler.flush();
  assert.ok(labels.every((l) => l.show));

  renderer.clear('trail');
  assert.equal(items(viewer).filter((i) => i.id === 'trail:a').length, 0);
  renderer.clear();
  assert.equal(renderer.featureCount, 0);
  renderer.dispose();
});

test('CesiumWorldRenderer: selection restyles in place, picks resolve to features, hover is frame-throttled', async () => {
  const { renderer, viewer, scheduler, events, cesium } = await mounted();
  renderer.update({
    upsert: [
      pt('obj:a', 10, 20, { styleClass: 'aircraft', size: 10 }),
      pt('obj:b', 11, 21, { styleClass: 'aircraft', size: 10 }),
    ],
    remove: [],
  });
  const find = (id: string) => items(viewer).find((i) => i.id === id)!;
  renderer.select('obj:a');
  assert.equal(find('obj:a').pixelSize, 12.5, 'selected emphasis');
  assert.equal(find('obj:a').outlineWidth, 2);
  renderer.select('obj:b');
  assert.equal(find('obj:a').pixelSize, 10, 'previous selection restored');
  assert.equal(find('obj:b').pixelSize, 12.5);
  // A later update keeps the selection highlight on the selected feature.
  renderer.update({ upsert: [pt('obj:b', 11.5, 21.5, { styleClass: 'aircraft', size: 10 })], remove: [] });
  assert.equal(find('obj:b').pixelSize, 12.5);

  const handler = cesium.handlers[0]!;
  viewer.scene.pickResult = { id: 'obj:a' };
  handler.fire(cesium.ScreenSpaceEventType.LEFT_CLICK, { position: { x: 100, y: 200 } });
  const pick = events.find((e) => e.type === 'pick')!.payload as PickResult;
  assert.equal(pick.featureId, 'obj:a');
  assert.equal(pick.objectId, 'a');
  assert.deepEqual(pick.position, { latitude: 10, longitude: 20, altitudeM: 9000 });
  assert.deepEqual(pick.screen, { x: 100, y: 200 });
  viewer.scene.pickResult = undefined;
  handler.fire(cesium.ScreenSpaceEventType.LEFT_CLICK, { position: { x: 1, y: 1 } });
  assert.equal(events.filter((e) => e.type === 'pick').at(-1)!.payload, null);
  // Non-interactive features never pick.
  renderer.update({ upsert: [{ ...pt('obj:n', 0, 0), interactive: false }], remove: [] });
  viewer.scene.pickResult = { id: 'obj:n' };
  handler.fire(cesium.ScreenSpaceEventType.LEFT_CLICK, { position: { x: 1, y: 1 } });
  assert.equal(events.filter((e) => e.type === 'pick').at(-1)!.payload, null);

  viewer.scene.pickResult = { id: 'obj:b' };
  handler.fire(cesium.ScreenSpaceEventType.MOUSE_MOVE, { endPosition: { x: 5, y: 5 } });
  handler.fire(cesium.ScreenSpaceEventType.MOUSE_MOVE, { endPosition: { x: 6, y: 6 } });
  assert.equal(events.filter((e) => e.type === 'hover').length, 0, 'hover waits for the frame');
  scheduler.flush();
  const hovers = events.filter((e) => e.type === 'hover');
  assert.equal(hovers.length, 1);
  assert.equal((hovers[0]!.payload as PickResult).featureId, 'obj:b');
  handler.fire(cesium.ScreenSpaceEventType.MOUSE_MOVE, { endPosition: { x: 7, y: 7 } });
  scheduler.flush();
  assert.equal(events.filter((e) => e.type === 'hover').length, 1, 'unchanged hover target is not re-emitted');
  renderer.dispose();
});

test('CesiumWorldRenderer: view state round-trips through the camera, flyTo resolves, suspend stops the render loop', async () => {
  const { renderer, viewer, events } = await mounted();
  renderer.setView({ center: { latitude: 48.85, longitude: 2.35 }, zoom: 10, headingDegrees: 45, pitchDegrees: -60 });
  const v = renderer.getView();
  assert.ok(Math.abs(v.center.latitude - 48.85) < 1e-9 && Math.abs(v.center.longitude - 2.35) < 1e-9);
  assert.ok(Math.abs(v.zoom - 10) < 1e-6, `zoom ${v.zoom}`);
  assert.equal(v.headingDegrees, 45);
  assert.ok(Math.abs(v.pitchDegrees + 60) < 1e-9);
  assert.ok(
    events.some((e) => e.type === 'viewChanged'),
    'camera change emitted viewChanged',
  );
  viewer.camera.rectangle = { west: 0.03, south: 0.8, east: 0.05, north: 0.9 };
  assert.ok(renderer.getView().bounds, 'bounds from computeViewRectangle');

  renderer.setView({ zoom: 3 }, { animate: true, durationMs: 500 });
  assert.equal(viewer.camera.flights.at(-1)!.duration, 0.5);
  await renderer.flyTo({ position: { latitude: 1, longitude: 2 }, altitudeM: 1234 }, { durationMs: 200 });
  assert.deepEqual(viewer.camera.flights.at(-1)!.destination, { x: 2, y: 1, z: 1234 });
  await renderer.flyTo({ position: { latitude: 0, longitude: 0 }, bounds: { west: -1, south: -1, east: 1, north: 1 } });
  assert.ok('west' in viewer.camera.flights.at(-1)!.destination, 'bounds fly to a rectangle');

  renderer.suspend();
  assert.equal(viewer.useDefaultRenderLoop, false);
  renderer.resume();
  assert.equal(viewer.useDefaultRenderLoop, true);
  renderer.dispose();
});

test('CesiumWorldRenderer: basemap descriptors, terrain descriptors (cached, generation-guarded) and attribution credits', async () => {
  const terrainCalls: string[] = [];
  const cesium = createFakeCesium({
    terrainFromUrl: async (url) => {
      terrainCalls.push(url);
      return fakeTerrainProvider(url);
    },
  });
  const { renderer, viewer, events } = await mounted({ cesium });
  await renderer.setBasemap({ kind: 'esri-world-imagery', id: 'esri', attribution: 'Powered by Esri' });
  assert.equal(renderer.basemapState?.activeId, 'esri-world-imagery');
  await renderer.setBasemap({ kind: 'pmtiles', id: 'pack', url: 'x', styleId: 'worldview-dark', attribution: '' });
  assert.match(
    (events.filter((e) => e.type === 'error').at(-1)!.payload as { message: string }).message,
    /2D map only/,
  );
  assert.equal(
    renderer.basemapState?.activeId,
    'esri-world-imagery',
    'unsupported descriptor leaves the stack untouched',
  );

  await renderer.setTerrain({ kind: 'ellipsoid' });
  assert.equal((viewer.scene.terrainProvider as { name?: string }).name, 'ellipsoid');
  assert.equal(viewer.scene.globe.depthTestAgainstTerrain, false);
  await renderer.setTerrain({
    kind: 'quantized-mesh',
    url: 'https://terrain.example/mesh',
    attribution: 'Terrain © Example',
  });
  await renderer.setTerrain({
    kind: 'quantized-mesh',
    url: 'https://terrain.example/mesh',
    attribution: 'Terrain © Example',
  });
  assert.deepEqual(terrainCalls, ['https://terrain.example/mesh'], 'terrain provider cached per id');
  assert.equal(viewer.scene.globe.depthTestAgainstTerrain, true);
  await renderer.setTerrain({ kind: 'local', path: 'packs/alps/terrain', attribution: 'Local' });
  assert.equal(terrainCalls.at(-1), 'packs/alps/terrain');
  await assert.rejects(renderer.setTerrain({ kind: 'cesium-ion-world-terrain' }), /ion token/);

  renderer.setAttribution([
    { id: 'usgs', text: 'Earthquakes: USGS', onScreen: false },
    { id: 'ne', text: 'Natural Earth', url: 'https://www.naturalearthdata.com', onScreen: true },
  ]);
  const credits = [...viewer.creditDisplay.credits];
  assert.ok(credits.some((c) => c.html === 'Earthquakes: USGS' && !c.showOnScreen));
  assert.ok(credits.some((c) => /naturalearthdata/.test(c.html) && c.showOnScreen));
  renderer.setAttribution([]);
  assert.ok(![...viewer.creditDisplay.credits].some((c) => c.html === 'Earthquakes: USGS'));
  renderer.dispose();
});

// ── real module ───────────────────────────────────────────────────────────────
let cesiumModule: CesiumModule | undefined;
let skipReason: string | false = false;
try {
  // @cesium/engine, never `cesium`: the latter re-exports @cesium/widgets, whose Knockout
  // copy evaluates a string at module scope, which the renderer's CSP refuses. See
  // cesium-module.ts. This test is the one that runs the adapter against the real
  // declarations, so it has to load what the renderer loads.
  cesiumModule = await import('@cesium/engine');
} catch (err) {
  skipReason = `@cesium/engine not installed in this environment (no registry access): ${(err as Error).message.split('\n')[0]} — verify on the operator machine`;
}

test(
  'CesiumWorldRenderer: the real cesium engine exposes every member the adapter relies on',
  { skip: skipReason },
  () => {
    const adapted = adaptCesiumModule(cesiumModule!);
    for (const [key, value] of Object.entries(adapted)) assert.ok(value !== undefined, `cesium.${key} present`);
    assert.equal(typeof adapted.buildModuleUrl('Assets/Textures/NaturalEarthII'), 'string');
    const c = adapted.Cartesian3.fromDegrees(10, 20, 30);
    const back = adapted.Cartographic.fromCartesian(c)!;
    assert.ok(Math.abs(adapted.Math.toDegrees(back.latitude) - 20) < 1e-9);
  },
);

test(
  'CesiumWorldRenderer: constructs a CesiumWidget against a real WebGL canvas',
  {
    skip:
      skipReason ||
      'needs a browser/Electron renderer with WebGL (no DOM in node:test); covered by the desktop smoke test',
  },
  () => {
    assert.fail('unreachable');
  },
);
