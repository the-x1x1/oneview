import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualScheduler, type PickResult, type RenderFeature } from '@worldview/render-core';
import { ALWAYS_VISIBLE, type HorizonTest, type Vec3 } from './horizon.js';
import { CesiumWorldRenderer, type VisibilityTarget } from './renderer.js';
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

async function mounted(
  opts: {
    cesium?: FakeCesium;
    visibility?: VisibilityTarget;
    horizon?: (camera: Vec3) => HorizonTest;
    wallNow?: () => number;
  } = {},
) {
  const cesium = opts.cesium ?? createFakeCesium();
  const scheduler = new ManualScheduler();
  const renderer = new CesiumWorldRenderer({
    cesium,
    createCanvas: fakeCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.wallNow ? { wallNow: opts.wallNow } : {}),
    // The fake's coordinates are lon/lat/height, not Earth-fixed metres; the real horizon
    // test has its own tests (horizon.test.ts).
    horizon: opts.horizon ?? (() => ALWAYS_VISIBLE),
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
  disableDepthTestDistance?: number;
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
  assert.equal(viewer.targetFrameRate, 0, 'the render loop is not capped (the fake starts at 0 and nothing sets it)');
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
  // A few wheel turns out from a city must not lose the Earth: far enough for the whole
  // geostationary ring, and no farther.
  const maxZoom = viewer.scene.screenSpaceCameraController.maximumZoomDistance;
  assert.ok(maxZoom > 2 * 42_164_000 && maxZoom <= 200_000_000, String(maxZoom));
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
  // A clamped area gets its edge as a ground polyline: Cesium draws no outline on it.
  const alert = eventDs.entities.entities[0]!.options;
  assert.equal(alert.polygon!.outline, false);
  assert.equal(alert.polyline?.clampToGround, true);
  assert.equal((alert.polyline?.positions as unknown[]).length, 4, 'the outer ring, closed');
  const eqDs = ds.find((d) => d.name === 'worldview:earthquake')!;
  assert.ok(eqDs.entities.entities[0]!.options.ellipse);
  assert.equal(
    (eqDs.entities.entities[0]!.options.polyline?.positions as unknown[]).length,
    65,
    'a circle edge of 64 segments',
  );
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

test('CesiumWorldRenderer: no hover picking while the camera moves; the resting target resolves when it settles', async () => {
  const { renderer, viewer, scheduler, events, cesium } = await mounted();
  renderer.update({ upsert: [pt('obj:a', 10, 20), pt('obj:b', 11, 21)], remove: [] });
  const handler = cesium.handlers[0]!;
  let picks = 0;
  const scene = viewer.scene as unknown as { pick: (p: unknown) => unknown; pickResult: unknown };
  const pick = scene.pick.bind(scene);
  scene.pick = (p) => {
    picks++;
    return pick(p);
  };
  const hovers = () => events.filter((e) => e.type === 'hover');

  viewer.camera.moveStart.raise();
  for (const [id, x] of [
    ['obj:a', 5],
    ['obj:b', 6],
    ['obj:a', 7],
  ] as const) {
    scene.pickResult = { id };
    handler.fire(cesium.ScreenSpaceEventType.MOUSE_MOVE, { endPosition: { x, y: 5 } });
    scheduler.flush();
  }
  assert.equal(picks, 0, 'a drag moves the pointer every frame; none of those frames pays for a pick');
  assert.equal(hovers().length, 0);

  scene.pickResult = { id: 'obj:b' };
  viewer.camera.moveEnd.raise();
  scheduler.flush();
  assert.equal(picks, 1, 'one pick, where the pointer came to rest');
  assert.equal((hovers().at(-1)!.payload as PickResult).featureId, 'obj:b');

  // Once settled, hover is live again.
  scene.pickResult = { id: 'obj:a' };
  handler.fire(cesium.ScreenSpaceEventType.MOUSE_MOVE, { endPosition: { x: 9, y: 9 } });
  scheduler.flush();
  assert.equal((hovers().at(-1)!.payload as PickResult).featureId, 'obj:a');

  // A camera that settles with no pointer movement in between has nothing to resolve.
  viewer.camera.moveStart.raise();
  viewer.camera.moveEnd.raise();
  scheduler.flush();
  assert.equal(picks, 2);
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

test('frame counter: time spent hidden is not reported as a slow second', async () => {
  // The operator's perf log had windows reading 0 or 1 fps with no work being done, the
  // signature of a window that was hidden or covered: Chromium stops its frames, and the
  // first frame back closed a "second" that had lasted the whole absence. Visibility
  // changes restart the measurement; a freeze while visible still counts.
  const listeners = new Set<() => void>();
  const visibility: VisibilityTarget = {
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  const { renderer, scheduler, events, viewer } = await mounted({ visibility });
  const fps = () => events.filter((e) => e.type === 'frame').map((e) => (e.payload as { fps: number }).fps);
  const draw = (n: number, everyMs: number) => {
    for (let i = 0; i < n; i++) {
      scheduler.flush(everyMs);
      viewer.scene.postRender.raise(undefined);
    }
  };
  draw(70, 16);
  assert.ok(fps()[0]! >= 55, `smooth: ${fps().join(', ')}`);

  for (const l of listeners) l(); // hidden
  scheduler.flush(30_000);
  for (const l of listeners) l(); // visible again
  draw(70, 16);
  assert.ok(Math.min(...fps()) >= 55, `thirty hidden seconds are not a slow second: ${fps().join(', ')}`);

  // A visible freeze is still measured.
  const before = fps().length;
  scheduler.flush(900);
  draw(1, 16);
  draw(70, 16);
  assert.ok(
    fps()
      .slice(before)
      .some((f) => f < 55),
    `a visible stall still shows: ${fps().slice(before).join(', ')}`,
  );
  assert.equal(listeners.size, 1, 'one listener');
  renderer.dispose();
  assert.equal(listeners.size, 0, 'and it is removed on dispose');
});

test('frame counter: the longest frame of each second is reported, and a suspension is not one', async () => {
  // A 150 ms stall costs a second only ~8 of its 60 frames, so fps alone reads ~52 for a
  // hitch anyone can see. The longest gap between frames is the number that shows it.
  const { renderer, scheduler, events, viewer } = await mounted();
  const samples = () =>
    events.filter((e) => e.type === 'frame').map((e) => e.payload as { fps: number; maxFrameMs?: number });
  const draw = (n: number, everyMs: number) => {
    for (let i = 0; i < n; i++) {
      scheduler.flush(everyMs);
      viewer.scene.postRender.raise(undefined);
    }
  };
  draw(70, 16);
  assert.equal(samples()[0]!.maxFrameMs, 16, 'a smooth second: every frame 16 ms');

  const before = samples().length;
  draw(20, 16);
  scheduler.flush(150);
  viewer.scene.postRender.raise(undefined);
  draw(140, 16);
  const hitch = samples().slice(before);
  assert.ok(hitch.length >= 2, `the stalled second and one after it: ${hitch.length}`);
  assert.ok(hitch[0]!.fps >= 50, `fps barely moves: ${hitch[0]!.fps}`);
  assert.equal(hitch[0]!.maxFrameMs, 150, 'but the stall is there to read');
  assert.equal(hitch.at(-1)!.maxFrameMs, 16, 'and the next second starts clean');

  // Suspended (the 2D map was showing): the render loop stopped. Coming back is not a slow frame.
  renderer.suspend();
  scheduler.flush(20_000);
  renderer.resume();
  const back = samples().length;
  draw(70, 16);
  const resumed = samples().slice(back);
  assert.ok(resumed[0]!.fps >= 55, `the first second back is not 0 fps: ${resumed[0]!.fps}`);
  assert.ok(resumed[0]!.maxFrameMs! <= 16, `nor a 20 s frame: ${resumed[0]!.maxFrameMs}`);
  renderer.dispose();
});

test('frame counter: the longest time Cesium itself spent on a frame is reported apart from the gap between frames', async () => {
  const { renderer, scheduler, events, viewer } = await mounted();
  const samples = () =>
    events.filter((e) => e.type === 'frame').map((e) => e.payload as { maxFrameMs?: number; engineMaxMs?: number });
  // Frames 16 ms apart of which Cesium spends 3 ms — and one in which it spends 40.
  for (let i = 0; i < 70; i++) {
    scheduler.flush(13);
    viewer.scene.preUpdate.raise(undefined);
    scheduler.flush(i === 30 ? 40 : 3);
    viewer.scene.postRender.raise(undefined);
  }
  const first = samples()[0]!;
  assert.equal(first.engineMaxMs, 40, 'the frame Cesium took 40 ms over');
  assert.ok(first.maxFrameMs! >= 40);
  renderer.dispose();
});

test('CesiumWorldRenderer: markers behind the Earth are hidden per camera position, not by the depth buffer', async () => {
  // In the fake, x is longitude. A test that sees only the camera's own hemisphere of
  // longitudes stands in for the ellipsoid's horizon; what is asserted is the plumbing.
  const hemisphere =
    (camera: Vec3): HorizonTest =>
    (p) =>
      camera.x >= 0 ? p.x >= 0 : p.x < 0;
  const { renderer, viewer } = await mounted({ horizon: hemisphere });
  renderer.update({
    upsert: [
      pt('obj:east', 10, 40),
      pt('obj:west', 10, -40),
      pt('obj:ico', 5, -60, { styleClass: 'aircraft', icon: 'aircraft' }),
    ],
    remove: [],
  });
  const find = (id: string) => items(viewer).find((i) => i.id === id)!;
  viewer.camera.setView({ destination: { x: 30, y: 0, z: 20_000_000 } });
  viewer.scene.preRender.raise(undefined);
  assert.equal(find('obj:east').show, true);
  assert.equal(find('obj:west').show, false, 'behind the planet');
  assert.equal(find('obj:ico').show, false, 'icons too');
  assert.equal(
    find('obj:east').disableDepthTestDistance,
    Number.POSITIVE_INFINITY,
    'no per-pixel depth test to cut dots in half',
  );

  // A feature arriving between camera moves uses the current horizon straight away.
  renderer.update({ upsert: [pt('obj:west2', 0, -10)], remove: [] });
  assert.equal(find('obj:west2').show, false);

  viewer.camera.setView({ destination: { x: -30, y: 0, z: 20_000_000 } });
  viewer.scene.preRender.raise(undefined);
  assert.equal(find('obj:east').show, false);
  assert.equal(find('obj:west').show, true, 'the camera went round');
  renderer.dispose();
});

test('CesiumWorldRenderer: an area label sits on the circle’s northern edge, clear of what is at its centre', async () => {
  const { renderer, viewer, scheduler } = await mounted();
  renderer.update({
    upsert: [
      {
        id: 'zone:z1',
        geometry: { kind: 'circle', center: { latitude: 29, longitude: 129 }, radiusM: 111_320 },
        style: { styleClass: 'watchzone', label: 'Zone near Uken', opacity: 0.5 },
        interactive: false,
        priority: 60,
        layer: 'watchzones',
      },
    ],
    remove: [],
  });
  scheduler.flush();
  const label = items(viewer).find((i) => i.text === 'Zone near Uken');
  assert.ok(label, 'the zone is labelled');
  const p = label.position as { x: number; y: number };
  assert.ok(
    Math.abs(p.y - 30) < 1e-9 && Math.abs(p.x - 129) < 1e-9,
    `one degree north of the centre: ${JSON.stringify(p)}`,
  );
  renderer.dispose();
});

test('CesiumWorldRenderer: a satellite with motion moves between its two positions as wall-clock time passes', async () => {
  let wall = Date.parse('2026-09-23T08:00:07.500Z');
  const { renderer, scheduler, viewer } = await mounted({ wallNow: () => wall });
  renderer.update({
    upsert: [
      {
        id: 'obj:satellite:norad:25544',
        objectId: 'satellite:norad:25544',
        geometry: { kind: 'point', position: { latitude: 10, longitude: 20, altitudeM: 420_000 } },
        style: { styleClass: 'satellite', heightMode: 'absolute' },
        interactive: true,
        priority: 30,
        layer: 'satellite',
        motion: {
          to: { latitude: 11, longitude: 22, altitudeM: 420_000 },
          fromMs: Date.parse('2026-09-23T08:00:00.000Z'),
          toMs: Date.parse('2026-09-23T08:00:15.000Z'),
        },
      },
    ],
    remove: [],
  });
  const dot = () => items(viewer).find((i) => i.id === 'obj:satellite:norad:25544')!;
  assert.deepEqual(
    dot().position,
    { x: 21, y: 10.5, z: 420_000 },
    'placed where it is now, not where it was at the poll',
  );
  wall += 7_500;
  scheduler.flush(2_500);
  viewer.scene.preRender.raise(undefined);
  assert.deepEqual(dot().position, { x: 22, y: 11, z: 420_000 }, 'and moved on as time passes');
  renderer.update({
    upsert: [
      {
        id: 'obj:satellite:norad:25544',
        objectId: 'satellite:norad:25544',
        geometry: { kind: 'point', position: { latitude: 12, longitude: 24, altitudeM: 420_000 } },
        style: { styleClass: 'satellite', heightMode: 'absolute' },
        interactive: true,
        priority: 30,
        layer: 'satellite',
      },
    ],
    remove: [],
  });
  wall += 5_000;
  scheduler.flush(2_500);
  viewer.scene.preRender.raise(undefined);
  assert.deepEqual(dot().position, { x: 24, y: 12, z: 420_000 }, 'without motion (paused) it stays where it is put');
  renderer.dispose();
});
