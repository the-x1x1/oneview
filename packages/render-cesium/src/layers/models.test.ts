import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphicsProfile, ManualScheduler, withModels, type RenderFeature } from '@worldview/render-core';
import { ALWAYS_VISIBLE } from '../horizon.js';
import { CesiumWorldRenderer } from '../renderer.js';
import { createFakeCesium, fakeCanvasFactory, type FakeCesium, type FakeModel } from '../testing/fake-cesium.js';
import {
  attitudeFor,
  bearingDegrees,
  chooseModelled,
  distanceM,
  ICON_MODEL,
  MODEL_ASSETS,
  MODEL_CAP,
  modelCreditHtml,
  modelKindFor,
  modelMatrixValues,
  positionNow,
} from './models.js';

const feature = (
  id: string,
  lat: number,
  lon: number,
  style: Partial<RenderFeature['style']> = {},
  extra: Partial<RenderFeature> = {},
): RenderFeature => ({
  id,
  geometry: { kind: 'point', position: { latitude: lat, longitude: lon, altitudeM: 3000 } },
  style: { styleClass: 'aircraft', icon: 'aircraft', heightMode: 'absolute', ...style },
  interactive: true,
  priority: 50,
  layer: 'aircraft',
  ...extra,
});

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const col = (m: number[], i: number) => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: number[], b: number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];

test('modelKindFor: the marker icon decides; no icon, no model; a balloon or glider has none', () => {
  assert.equal(modelKindFor(feature('a', 0, 0)), 'airliner');
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'aircraft-heavy' })), 'widebody');
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'aircraft-business' })), 'business');
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'helicopter' })), 'helicopter');
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'uav' })), 'uav');
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'vessel', styleClass: 'vessel' })), 'ship');
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'balloon' })), undefined);
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'aircraft-glider' })), undefined);
  assert.equal(modelKindFor(feature('a', 0, 0, { icon: 'satellite' })), undefined);
  const dotOnly = feature('a', 0, 0);
  delete dotOnly.style.icon;
  assert.equal(modelKindFor(dotOnly), undefined, 'a dot (the governor took the icons away) gets no model');
});

test('every kind has an asset with a CC BY 4.0 credit, and every file is one of the nine bundled', () => {
  const files = new Set(Object.values(MODEL_ASSETS).map((a) => a.file));
  assert.deepEqual([...files].sort(), [
    'airplane.glb',
    'atr72.glb',
    'b789.glb',
    'bell206.glb',
    'c172.glb',
    'citation2.glb',
    'jet.glb',
    'mq9.glb',
    'ship.glb',
  ]);
  for (const kind of new Set(Object.values(ICON_MODEL))) assert.ok(MODEL_ASSETS[kind], kind);
  const html = modelCreditHtml(MODEL_ASSETS.widebody.credit);
  assert.match(html, /“Boeing 787-9”/);
  assert.match(html, /Nobilis 2/);
  assert.match(html, /CC BY 4\.0/);
  assert.match(html, /modified/);
  assert.match(
    modelCreditHtml({ title: '<b>', author: 'a&b', authorUrl: 'https://x', sourceUrl: 'https://y' }),
    /&lt;b&gt;.*a&amp;b/,
  );
});

test('chooseModelled: nearest first, within range, capped; a held one keeps its model a little further', () => {
  const c = (id: string, distanceM: number) => ({ id, distanceM });
  assert.deepEqual(chooseModelled([c('far', 40_000), c('b', 2000), c('a', 1000)], new Set(), 24, 30_000, 36_000), [
    'a',
    'b',
  ]);
  assert.deepEqual(chooseModelled([c('x', 33_000)], new Set(), 24, 30_000, 36_000), [], 'new: beyond the range');
  assert.deepEqual(chooseModelled([c('x', 33_000)], new Set(['x']), 24, 30_000, 36_000), ['x'], 'held: kept');
  const many = Array.from({ length: 40 }, (_, i) => c(`o${String(i).padStart(2, '0')}`, 1000 + i * 100));
  const chosen = chooseModelled(many, new Set());
  assert.equal(chosen.length, MODEL_CAP);
  assert.equal(chosen[0], 'o00');
  // A held object at 1,050 m keeps its place against a newcomer at 1,000 m.
  assert.deepEqual(chooseModelled([c('new', 1000), c('held', 1050)], new Set(['held']), 1), ['held']);
  assert.deepEqual(chooseModelled([c('nan', Number.NaN)], new Set()), []);
});

test('modelMatrixValues: heading north at 0°N 0°E puts the nose north, the right wing east, the top up', () => {
  const m = modelMatrixValues(0, 0, 0, 0, 0, { scale: 1, forward: '-x' });
  // At (0, 0): east = +Y, north = +Z, up = +X in Earth-fixed coordinates.
  const nose = col(m, 0).map((v) => -v);
  assert.deepEqual(
    nose.map((v) => Math.round(v * 1e9) / 1e9),
    [0, 0, 1],
    'model −X → north',
  );
  assert.deepEqual(
    col(m, 1).map((v) => Math.round(v * 1e9) / 1e9),
    [0, 1, 0],
    'model +Y → east',
  );
  assert.deepEqual(
    col(m, 2).map((v) => Math.round(v * 1e9) / 1e9),
    [1, 0, 0],
    'model +Z → up',
  );
  assert.ok(near(m[12]!, 6_378_137, 1e-6) && near(m[13]!, 0, 1e-6) && near(m[14]!, 0, 1e-6), 'on the equator');
  assert.equal(m[15], 1);
});

test('modelMatrixValues: heading east turns the nose east; a climb tilts it up by the pitch', () => {
  const east = modelMatrixValues(0, 0, 0, 90, 0, { scale: 1, forward: '-x' });
  assert.ok(near(-east[1]!, 1, 1e-12), 'nose along +Y (east)');
  const climb = modelMatrixValues(0, 0, 0, 0, 10, { scale: 1, forward: '-x' });
  const nose = col(climb, 0).map((v) => -v);
  assert.ok(near(nose[0]!, Math.sin((10 * Math.PI) / 180), 1e-12), 'the nose points 10° above the horizon');
});

test('modelMatrixValues: a ship (bow −Y) heading north has its bow north and its starboard side east', () => {
  const m = modelMatrixValues(0, 0, 0, 0, 0, { scale: 1, forward: '-y' });
  const bow = col(m, 1).map((v) => -v);
  assert.deepEqual(
    bow.map((v) => Math.round(v * 1e9) / 1e9),
    [0, 0, 1],
  );
  const starboard = col(m, 0).map((v) => -v); // glTF's right of the bow is the model's −X
  assert.deepEqual(
    starboard.map((v) => Math.round(v * 1e9) / 1e9),
    [0, 1, 0],
  );
});

test('modelMatrixValues: always a scaled rotation (orthogonal, right-handed) at the WGS84 position', () => {
  for (const [lat, lon, h, hdg, pitch, forward] of [
    [51.5, -0.12, 11_000, 237, -4, '-x'],
    [-33.9, 151.2, 0, 12, 0, '-y'],
    [78, 15, 300, 359, 20, '-x'],
  ] as const) {
    const s = 0.5;
    const m = modelMatrixValues(lat, lon, h, hdg, pitch, { scale: s, forward });
    const [x, y, z] = [col(m, 0), col(m, 1), col(m, 2)];
    for (const v of [x, y, z]) assert.ok(near(Math.sqrt(dot(v, v)), s, 1e-9));
    assert.ok(near(dot(x, y), 0, 1e-9) && near(dot(y, z), 0, 1e-9) && near(dot(x, z), 0, 1e-9));
    const handed = dot(cross(x, y), z);
    assert.ok(handed > 0, 'right-handed: no mirrored model');
    const r = Math.hypot(m[12]!, m[13]!, m[14]!);
    assert.ok(r > 6_356_000 + h - 1 && r < 6_378_138 + h, 'on the ellipsoid, raised by the height');
  }
});

test('attitudeFor: the reported heading wins; else the move; pitch from the climb, clamped; ships level', () => {
  const moving = feature(
    'a',
    0,
    0,
    {},
    {
      motion: { to: { latitude: 0.01, longitude: 0, altitudeM: 3300 }, fromMs: 0, toMs: 10_000 },
    },
  );
  const a = attitudeFor(moving, 'airliner');
  assert.ok(near(a.headingDeg, 0, 1e-6), 'north, from the move');
  assert.ok(a.pitchDeg > 15 && a.pitchDeg <= 20, `300 m up over 1.1 km, clamped to 20°: ${a.pitchDeg}`);
  assert.equal(attitudeFor({ ...moving, style: { ...moving.style, rotationDegrees: 45 } }, 'airliner').headingDeg, 45);
  assert.equal(attitudeFor(moving, 'ship').pitchDeg, 0);
  assert.deepEqual(attitudeFor(feature('b', 0, 0), 'airliner'), { headingDeg: 0, pitchDeg: 0 });
});

test('distance, bearing and where a moving feature is now', () => {
  const d = distanceM({ latitude: 0, longitude: 0, heightM: 0 }, { latitude: 0, longitude: 1, heightM: 0 });
  assert.ok(Math.abs(d - 111_195) < 50, `${d}`);
  assert.ok(near(bearingDegrees({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }), 90, 1e-9));
  const f = feature(
    'a',
    0,
    0,
    {},
    {
      motion: { to: { latitude: 1, longitude: 0, altitudeM: 5000 }, fromMs: 0, toMs: 1000 },
    },
  );
  assert.deepEqual(positionNow(f, 500), { latitude: 0.5, longitude: 0, altitudeM: 4000 });
});

// ── the layer on the renderer, with the fake Cesium ─────────────────────────────────────────

const container = () =>
  ({
    ownerDocument: { createElement: () => ({ className: '', remove() {} }) },
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as HTMLElement;

async function mountedWithModels(
  opts: { cesium?: FakeCesium; models3d?: boolean | undefined; wallNow?: () => number } = {},
) {
  const cesium = opts.cesium ?? createFakeCesium();
  const scheduler = new ManualScheduler();
  const errors: string[] = [];
  const renderer = new CesiumWorldRenderer({
    cesium,
    createCanvas: fakeCanvasFactory(),
    scheduler,
    now: () => scheduler.now(),
    wallNow: opts.wallNow ?? (() => 0),
    horizon: () => ALWAYS_VISIBLE,
    graphics: withModels(graphicsProfile('balanced'), opts.models3d),
    modelBaseUrl: './models/',
  });
  renderer.on('error', (e) => errors.push(e.message));
  await renderer.mount(container());
  const viewer = cesium.viewers[0]!;
  // Close in over (0, 0): 5 km up.
  viewer.camera.setView({ destination: cesium.Cartesian3.fromDegrees(0, 0, 5000) });
  const frame = async () => {
    viewer.scene.preRender.raise(undefined);
    await new Promise((r) => setImmediate(r));
  };
  return { cesium, renderer, viewer, scheduler, errors, frame };
}

const billboardOf = (viewer: ReturnType<typeof createFakeCesium>['viewers'][number], id: string) => {
  for (const p of viewer.scene.primitives.items) {
    // Billboards only (they carry a rotation): the models' own collection holds ids too.
    const c = p as { items?: Array<{ id: unknown; show: boolean; rotation?: number }> };
    const b = c.items?.find((i) => i.id === id && i.rotation !== undefined);
    if (b) return b;
  }
  return undefined;
};

test('ModelLayer: a near aircraft gets a model; its icon stays until the model is ready, then hides, and credit shows', async () => {
  const { cesium, renderer, viewer, frame } = await mountedWithModels();
  renderer.update({ upsert: [feature('obj:a', 0.01, 0.01, { rotationDegrees: 90 })], remove: [] });
  await frame();
  assert.deepEqual(renderer.modelState.assigned, ['obj:a']);
  assert.equal(cesium.models.length, 1);
  const model = cesium.models[0]!;
  assert.equal(model.options.url, './models/airplane.glb');
  assert.equal(model.show, true);
  assert.equal(model.id, 'obj:a', 'picking the model picks the aircraft');
  assert.equal(billboardOf(viewer, 'obj:a')?.show, true, 'the icon stays until the model can be drawn');
  const credits = () => [...viewer.creditDisplay.credits].map((c) => c.html).join('\n');
  assert.doesNotMatch(credits(), /boeing 747/);
  const before = viewer.scene.renderRequests;
  model.markReady();
  assert.equal(billboardOf(viewer, 'obj:a')?.show, false, 'the model stands in for the icon');
  assert.deepEqual(renderer.modelState.drawn, ['obj:a']);
  assert.match(credits(), /“boeing 747”.*zairiq-123.*CC BY 4\.0/);
  assert.ok(viewer.scene.renderRequests > before, 'a model that becomes ready asks for a frame');
  // The matrix places it on the ellipsoid near (0.01, 0.01), heading east: nose along +Y.
  const m = model.matrix;
  assert.ok(m[12]! > 6_378_000 && m[12]! < 6_390_000, `x ${m[12]}`);
  assert.ok(-m[1]! > 0.7 * MODEL_ASSETS.airliner.scale, 'nose east');
});

test('ModelLayer: too high, too far, or switched off — no models, and the icons come back', async () => {
  const { cesium, renderer, viewer, frame } = await mountedWithModels();
  renderer.update({ upsert: [feature('obj:a', 0.01, 0.01), feature('obj:far', 2, 2)], remove: [] });
  await frame();
  assert.deepEqual(renderer.modelState.assigned, ['obj:a'], 'the one 200 km away is not modelled');
  cesium.models[0]!.markReady();
  assert.equal(billboardOf(viewer, 'obj:a')?.show, false);
  renderer.setGraphics(withModels(graphicsProfile('balanced'), false));
  assert.deepEqual(renderer.modelState.assigned, []);
  assert.equal(billboardOf(viewer, 'obj:a')?.show, true, 'switched off: the icon is back');
  assert.equal(cesium.models[0]!.show, false);
  assert.equal(
    [...viewer.creditDisplay.credits].some((c) => /boeing/.test(c.html)),
    false,
    'no credit without a model',
  );
  renderer.setGraphics(graphicsProfile('balanced'));
  await frame();
  assert.deepEqual(renderer.modelState.assigned, ['obj:a']);
  assert.equal(cesium.models.length, 1, 'the released model is reused, not loaded again');
  viewer.camera.setView({ destination: cesium.Cartesian3.fromDegrees(0, 0, 80_000) });
  await frame();
  assert.deepEqual(renderer.modelState.assigned, [], 'above the ceiling nothing is modelled');
});

test('ModelLayer: Low quality draws none by default; the operator can turn them on', async () => {
  const low = await mountedWithModels({ models3d: undefined });
  low.renderer.setGraphics(graphicsProfile('low'));
  low.renderer.update({ upsert: [feature('obj:a', 0.01, 0.01)], remove: [] });
  await low.frame();
  assert.deepEqual(low.renderer.modelState.assigned, []);
  low.renderer.setGraphics(withModels(graphicsProfile('low'), true));
  await low.frame();
  assert.deepEqual(low.renderer.modelState.assigned, ['obj:a']);
});

test('ModelLayer: never more than the cap, nearest first; one file load per kind', async () => {
  const { cesium, renderer, frame } = await mountedWithModels();
  const many = Array.from({ length: 40 }, (_, i) => feature(`obj:${String(i).padStart(2, '0')}`, 0.001 * (i + 1), 0));
  renderer.update({ upsert: many, remove: [] });
  await frame();
  const assigned = renderer.modelState.assigned;
  assert.equal(assigned.length, MODEL_CAP);
  assert.ok(assigned.includes('obj:00') && !assigned.includes('obj:39'), 'the nearest ones');
  assert.ok(renderer.modelState.instances <= MODEL_CAP);
  // Every instance asks for the same url; Cesium's resource cache makes that one fetch.
  assert.deepEqual([...cesium.modelLoads.keys()], ['./models/airplane.glb']);
});

test('ModelLayer: kinds by class, ships on the ground reference; a failed file leaves its kind as icons, said once', async () => {
  const cesium = createFakeCesium({ model: (url) => (url.endsWith('b789.glb') ? 'fail' : 'load') });
  const { renderer, viewer, errors, frame } = await mountedWithModels({ cesium });
  renderer.update({
    upsert: [
      feature('obj:ship', 0.01, 0, { icon: 'vessel', styleClass: 'vessel', heightMode: 'clamp' }, { layer: 'vessel' }),
      feature('obj:heavy', 0.02, 0, { icon: 'aircraft-heavy' }),
      feature('obj:heavy2', 0.03, 0, { icon: 'aircraft-heavy' }),
    ],
    remove: [],
  });
  await frame();
  await frame();
  const ship = cesium.models.find((m: FakeModel) => m.options.url.endsWith('ship.glb'))!;
  assert.ok(ship, 'the ship has a model');
  assert.equal(ship.heightReference, cesium.HeightReference.RELATIVE_TO_GROUND, 'a ship sits on the sea surface');
  assert.equal(errors.filter((e) => /b789\.glb/.test(e)).length, 1, 'the failure is reported once');
  assert.deepEqual(renderer.modelState.assigned, ['obj:ship']);
  assert.equal(billboardOf(viewer, 'obj:heavy')?.show, true, 'the wide-body stays an icon');
});

test('ModelLayer: a moving aircraft is carried by the markers step; a selected one is outlined; removal releases', async () => {
  let wall = 0;
  const { cesium, renderer, viewer, scheduler, frame } = await mountedWithModels({ wallNow: () => wall });
  const moving = feature(
    'obj:m',
    0,
    0,
    { rotationDegrees: 0 },
    {
      motion: { to: { latitude: 0.01, longitude: 0, altitudeM: 3000 }, fromMs: 0, toMs: 10_000 },
    },
  );
  renderer.update({ upsert: [moving], remove: [] });
  await frame();
  const model = cesium.models[0]!;
  model.markReady();
  const z0 = model.matrix[14]!;
  wall = 5000;
  scheduler.flush(2000); // the frame clock past the next step
  viewer.scene.preRender.raise(undefined);
  assert.ok(model.matrix[14]! > z0, 'moved north with wall-clock time');
  renderer.select('obj:m');
  await frame();
  assert.equal(model.silhouetteSize, 2);
  renderer.update({ upsert: [], remove: ['obj:m'] });
  await frame();
  assert.deepEqual(renderer.modelState.assigned, []);
  assert.equal(model.show, false);
  renderer.dispose();
  assert.equal(model.isDestroyed(), true);
});
