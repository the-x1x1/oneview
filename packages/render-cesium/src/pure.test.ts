import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderFeature } from '@worldview/render-core';
import { declutterLabels, estimateLabelSize, labelBox } from './labelDeclutter.js';
import {
  altitudeForBounds,
  cameraToViewState,
  normalizeHeadingDegrees,
  resolveFlyTarget,
  viewStateToCamera,
} from './view.js';
import { pickAnchor, resolvePickedFeatureId, toPickResult } from './picking.js';
import { FeatureStore, routeFeature } from './featureRouter.js';
import { attributionHtml, CreditSync, createMapCredits, escapeHtml } from './attribution.js';
import { boundedPinchDelta, installTrackpadPinchZoom, viewerOptions } from './viewer.js';
import { flattenPositions, heightFor, positionsValid } from './geometry.js';
import { headingToBillboardRotation, iconSizePx } from './layers/billboards.js';
import { MARKER_DEPTH_TEST_DISTANCE_M } from './layers/depth.js';
import { resolveStyle, zoomToAltitudeM } from '@worldview/render-core';

const DEG = Math.PI / 180;

test('label declutter: priority wins collisions, deterministic ties, off-screen hidden', () => {
  const vp = { width: 800, height: 600 };
  const a = { id: 'a', x: 100, y: 100, width: 60, height: 14, priority: 10 };
  const b = { id: 'b', x: 120, y: 105, width: 60, height: 14, priority: 50 };
  const c = { id: 'c', x: 400, y: 300, width: 60, height: 14, priority: 1 };
  const off = { id: 'off', x: -500, y: 100, width: 60, height: 14, priority: 99 };
  const nan = { id: 'nan', x: Number.NaN, y: 0, width: 10, height: 10, priority: 99 };
  const visible = declutterLabels([a, b, c, off, nan], vp);
  assert.deepEqual([...visible].sort(), ['b', 'c']);
  // Equal priority: id order decides, and the result is stable regardless of input order.
  const t1 = { ...a, priority: 5 },
    t2 = { ...b, priority: 5 };
  assert.deepEqual([...declutterLabels([t1, t2], vp)], ['a']);
  assert.deepEqual([...declutterLabels([t2, t1], vp)], ['a']);
  // Centred anchor vs hanging anchor produce different boxes.
  assert.equal(labelBox({ ...a, anchor: 'center' }).top, 93);
  assert.equal(labelBox(a).top, 100);
  assert.deepEqual(estimateLabelSize('ABCD', 12), { width: 28, height: 16 });
  // Large sets across grid cells stay consistent: non-overlapping labels are all visible.
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`,
    x: (i % 20) * 40,
    y: Math.floor(i / 20) * 40,
    width: 30,
    height: 12,
    priority: i,
  }));
  assert.equal(declutterLabels(many, { width: 800, height: 400 }).size, 200);
});

test('view: camera ↔ ViewState round trip, zoom/altitude coupling, heading normalisation', () => {
  const view = cameraToViewState({
    longitude: 10 * DEG,
    latitude: 50 * DEG,
    height: 12_000,
    heading: 90 * DEG,
    pitch: -45 * DEG,
    rectangle: { west: 9 * DEG, south: 49 * DEG, east: 11 * DEG, north: 51 * DEG },
  });
  assert.ok(Math.abs(view.center.latitude - 50) < 1e-9 && Math.abs(view.center.longitude - 10) < 1e-9);
  assert.equal(view.altitudeM, 12_000);
  assert.equal(view.headingDegrees, 90);
  assert.equal(view.pitchDegrees, -45);
  assert.ok(Math.abs(view.bounds!.west - 9) < 1e-9 && Math.abs(view.bounds!.north - 51) < 1e-9);
  const back = viewStateToCamera(view, view);
  assert.ok(Math.abs(back.height - 12_000) < 1e-6);
  assert.ok(Math.abs(back.heading - 90 * DEG) < 1e-12);
  assert.ok(Math.abs(back.pitch + 45 * DEG) < 1e-12);
  const again = cameraToViewState({
    longitude: back.longitude * DEG,
    latitude: back.latitude * DEG,
    height: back.height,
    heading: back.heading,
    pitch: back.pitch,
  });
  assert.ok(Math.abs(again.zoom - view.zoom) < 1e-9, 'zoom stable through the round trip');

  // zoom alone drives altitude; altitude alone drives nothing else.
  const fromZoom = viewStateToCamera({ zoom: 10 }, view);
  assert.equal(
    fromZoom.height,
    zoomToAltitudeM(10, 50),
    'altitude derived with the shared contract formula at the view latitude',
  );
  assert.equal(viewStateToCamera({ altitudeM: 5 }, view).height, 5);
  assert.equal(normalizeHeadingDegrees(-90), 270);
  assert.equal(normalizeHeadingDegrees(450), 90);
  assert.equal(viewStateToCamera({ headingDegrees: -90 }, view).heading, 270 * DEG);
  assert.equal(viewStateToCamera({ pitchDegrees: 200 }, view).pitch, 89 * DEG, 'pitch clamped below the horizon');
});

test('view: fly targets prefer bounds, then altitude, then zoom, then a sensible default', () => {
  const current = {
    center: { latitude: 0, longitude: 0 },
    altitudeM: 8_000_000,
    zoom: 1,
    headingDegrees: 0,
    pitchDegrees: -90,
  };
  const bounds = { west: -1, south: -1, east: 1, north: 1 };
  assert.deepEqual(resolveFlyTarget({ position: { latitude: 0, longitude: 0 }, bounds }, current), {
    kind: 'bounds',
    bounds,
  });
  assert.equal(
    (resolveFlyTarget({ position: { latitude: 1, longitude: 2 }, altitudeM: 300 }, current) as { height: number })
      .height,
    300,
  );
  const z = resolveFlyTarget({ position: { latitude: 1, longitude: 2 }, zoom: 12 }, current) as { height: number };
  assert.equal(z.height, zoomToAltitudeM(12, 1));
  assert.equal(
    (resolveFlyTarget({ position: { latitude: 1, longitude: 2 } }, current) as { height: number }).height,
    50_000,
  );
  assert.ok(altitudeForBounds(bounds) > 200_000 && altitudeForBounds(bounds) < 1_000_000);
  assert.equal(altitudeForBounds({ west: 0, south: 0, east: 0.0001, north: 0.0001 }), 500, 'minimum altitude');
  const wrapped = altitudeForBounds({ west: 170, south: -10, east: -170, north: 10 });
  assert.ok(wrapped > 1_000_000, 'antimeridian-crossing bounds measured the short way');
});

test('picking: primitive ids and entity ids resolve to feature ids; anchors prefer the feature position', () => {
  assert.equal(resolvePickedFeatureId({ id: 'obj:a' }), 'obj:a');
  assert.equal(resolvePickedFeatureId({ id: { id: 'obj:b' } }), 'obj:b');
  assert.equal(resolvePickedFeatureId({ primitive: {} }), undefined);
  assert.equal(resolvePickedFeatureId(undefined), undefined);
  assert.equal(resolvePickedFeatureId({ id: 42 }), undefined);
  const point: RenderFeature = {
    id: 'obj:a',
    objectId: 'a',
    geometry: { kind: 'point', position: { latitude: 1, longitude: 2, altitudeM: 3 } },
    style: { styleClass: 's' },
    interactive: true,
    priority: 1,
    layer: 'l',
  };
  assert.deepEqual(pickAnchor(point, { latitude: 9, longitude: 9 }), { latitude: 1, longitude: 2, altitudeM: 3 });
  const poly: RenderFeature = { ...point, geometry: { kind: 'polygon', rings: [[{ latitude: 0, longitude: 0 }]] } };
  assert.deepEqual(pickAnchor(poly, { latitude: 9, longitude: 9 }), { latitude: 9, longitude: 9 });
  const r = toPickResult('obj:a', point, { latitude: 1, longitude: 2 }, { x: 5, y: 6 });
  assert.deepEqual(r, {
    featureId: 'obj:a',
    objectId: 'a',
    position: { latitude: 1, longitude: 2 },
    screen: { x: 5, y: 6 },
  });
  assert.equal('eventId' in toPickResult('x', undefined, { latitude: 0, longitude: 0 }, { x: 0, y: 0 }), false);
});

test('feature routing and store: routes per geometry/style, replaceLayers, layer moves and removals', () => {
  const base: RenderFeature = {
    id: 'p',
    geometry: { kind: 'point', position: { latitude: 0, longitude: 0 } },
    style: { styleClass: 'aircraft' },
    interactive: true,
    priority: 1,
    layer: 'aircraft',
  };
  assert.deepEqual(routeFeature(base), ['point']);
  assert.deepEqual(routeFeature({ ...base, style: { styleClass: 'aircraft', icon: 'aircraft', label: 'X' } }), [
    'billboard',
    'label',
  ]);
  assert.deepEqual(
    routeFeature({
      ...base,
      geometry: {
        kind: 'cluster',
        position: { latitude: 0, longitude: 0 },
        count: 3,
        bounds: { west: 0, south: 0, east: 1, north: 1 },
      },
    }),
    ['cluster', 'label'],
  );
  assert.deepEqual(routeFeature({ ...base, geometry: { kind: 'line', positions: [] } }), ['polyline']);
  assert.deepEqual(
    routeFeature({ ...base, geometry: { kind: 'polygon', rings: [] }, style: { styleClass: 'e', label: 'L' } }),
    ['polygon', 'label'],
  );
  assert.deepEqual(
    routeFeature({ ...base, geometry: { kind: 'circle', center: { latitude: 0, longitude: 0 }, radiusM: 1 } }),
    ['circle'],
  );
  assert.deepEqual(
    routeFeature({
      ...base,
      geometry: { kind: 'density', bounds: { west: 0, south: 0, east: 1, north: 1 }, count: 1, intensity: 1 },
    }),
    ['density'],
  );

  const store = new FeatureStore();
  const r1 = store.apply({ upsert: [base, { ...base, id: 'q', layer: 'vessel' }], remove: [] });
  assert.equal(r1.upserted.length, 2);
  assert.deepEqual(store.layers().sort(), ['aircraft', 'vessel']);
  // Move p to another layer with a different route → previous carries old layer/routes.
  const r2 = store.apply({
    upsert: [{ ...base, layer: 'moved', style: { styleClass: 'a', icon: 'aircraft' } }],
    remove: ['q'],
  });
  assert.equal(r2.removed[0]!.id, 'q');
  assert.equal(r2.upserted[0]!.previous!.feature.layer, 'aircraft');
  assert.deepEqual(r2.upserted[0]!.next.routes, ['billboard']);
  assert.deepEqual(store.idsInLayer('aircraft'), []);
  assert.deepEqual(store.idsInLayer('moved'), ['p']);
  // replaceLayers clears everything in the layer not re-upserted.
  store.apply({
    upsert: [
      { ...base, id: 'm1', layer: 'moved' },
      { ...base, id: 'm2', layer: 'moved' },
    ],
    remove: [],
  });
  const r3 = store.apply({ upsert: [{ ...base, id: 'm1', layer: 'moved' }], remove: [], replaceLayers: ['moved'] });
  assert.deepEqual(r3.removed.map((r) => r.id).sort(), ['m2', 'p']);
  assert.deepEqual(store.idsInLayer('moved'), ['m1']);
  assert.deepEqual(store.clear('moved'), ['m1']);
  assert.equal(store.size, 0);
});

test('attribution: escaped credit markup, diffed static credits, map credit follows the stack', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(attributionHtml({ text: 'USGS <public domain>' }), 'USGS &lt;public domain&gt;');
  assert.equal(
    attributionHtml({ text: 'Esri', url: 'https://www.esri.com' }),
    '<a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>',
  );
  assert.equal(attributionHtml({ text: 'js', url: 'javascript:alert(1)' }), 'js', 'non-http urls are not linked');
  const display = {
    credits: [] as Array<{ html: string; showOnScreen: boolean }>,
    addStaticCredit(c: { html: string; showOnScreen: boolean }) {
      this.credits.push(c);
    },
    removeStaticCredit(c: { html: string; showOnScreen: boolean }) {
      this.credits.splice(this.credits.indexOf(c), 1);
    },
  };
  const sync = new CreditSync(display, (html, showOnScreen) => ({ html, showOnScreen }));
  const first = sync.apply([
    { id: 'usgs', text: 'USGS', onScreen: false },
    { id: 'osm', text: '© OpenStreetMap contributors', onScreen: true },
  ]);
  assert.deepEqual(first, { added: ['usgs', 'osm'], removed: [] });
  assert.deepEqual(
    sync.apply([
      { id: 'usgs', text: 'USGS', onScreen: false },
      { id: 'osm', text: '© OpenStreetMap contributors', onScreen: true },
    ]),
    { added: [], removed: [] },
    'same list is a no-op',
  );
  const changed = sync.apply([{ id: 'usgs', text: 'USGS (updated)', onScreen: false }]);
  assert.deepEqual(changed, { added: ['usgs'], removed: ['usgs', 'osm'] });
  assert.equal(display.credits.length, 1);
  assert.equal(display.credits[0]!.showOnScreen, false);
  sync.dispose();
  assert.equal(display.credits.length, 0);
  const map = createMapCredits(display, (html, showOnScreen) => ({ html, showOnScreen }));
  map.show('A');
  map.show('A');
  map.show('B');
  assert.equal(display.credits.length, 1);
  assert.equal(display.credits[0]!.html, 'B');
  assert.equal(display.credits[0]!.showOnScreen, true);
  map.destroy();
  assert.equal(display.credits.length, 0);
});

test('viewer: GEV options (no widgets, msaa 4, preserved buffer) and trackpad pinch relay', () => {
  const opts = viewerOptions({ container: {} as Element, creditContainer: {} as Element });
  // No widget-chrome flags to assert any more: the adapter builds a CesiumWidget, which
  // has no chrome. What has to stay true is that Cesium installs no base layer of its
  // own — WORLDVIEW picks the stack — and that the options carry nothing else.
  assert.deepEqual(Object.keys(opts).sort(), [
    'baseLayer',
    'contextOptions',
    'creditContainer',
    'msaaSamples',
    'requestRenderMode',
  ]);
  assert.equal(opts.baseLayer, false);
  assert.equal(opts.msaaSamples, 4);
  assert.equal(opts.contextOptions?.webgl?.preserveDrawingBuffer, true);
  assert.equal(boundedPinchDelta(2), 16);
  assert.equal(boundedPinchDelta(-100), -120);
  assert.equal(boundedPinchDelta(0), 0);
  assert.ok(Number.isNaN(boundedPinchDelta(Number.NaN)));

  const listeners = new Map<string, (e: unknown) => void>();
  const dispatched: unknown[] = [];
  const controller = {
    zoomEventTypes: [0, { eventType: 3, modifier: 0 }] as
      Array<number | { eventType: number; modifier: number }> | undefined,
  };
  const target = {
    scene: { screenSpaceCameraController: controller },
    container: {
      addEventListener: (t: string, l: (e: unknown) => void) => listeners.set(t, l),
      removeEventListener: (t: string) => listeners.delete(t),
    },
    canvas: {
      dispatchEvent: (e: object) => {
        dispatched.push(e);
        return true;
      },
    },
  };
  const created: Array<Record<string, unknown>> = [];
  const dispose = installTrackpadPinchZoom(
    { CameraEventType: { WHEEL: 3 }, KeyboardEventModifier: { CTRL: 1 } },
    target as never,
    (_type, init) => {
      const e = { ...init, type: 'wheel' };
      created.push(e);
      return e;
    },
  );
  assert.deepEqual(controller.zoomEventTypes!.at(-1), { eventType: 3, modifier: 1 }, 'Ctrl+wheel binding added');
  const relay = listeners.get('wheel')!;
  let prevented = 0;
  const wheel = (over: Partial<{ ctrlKey: boolean; deltaMode: number; deltaY: number }>) => ({
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -3,
    deltaZ: 0,
    screenX: 1,
    screenY: 2,
    clientX: 3,
    clientY: 4,
    preventDefault: () => {
      prevented++;
    },
    stopPropagation: () => undefined,
    ...over,
  });
  relay(wheel({}));
  assert.equal(dispatched.length, 1);
  assert.equal(created[0]!['deltaY'], -24, 'amplified ×8');
  assert.equal(created[0]!['ctrlKey'], true);
  assert.equal(prevented, 1);
  relay(dispatched[0]!); // the relayed event must not be amplified again
  relay(wheel({ ctrlKey: false }));
  relay(wheel({ deltaMode: 1 }));
  relay(wheel({ deltaY: 0 }));
  assert.equal(dispatched.length, 1);
  dispose();
  assert.equal(listeners.has('wheel'), false);
  assert.deepEqual(controller.zoomEventTypes, [0, { eventType: 3, modifier: 0 }], 'original bindings restored');
});

test('geometry and billboard helpers: height modes, validation, icon sizes, rotation', () => {
  const p = { latitude: 1, longitude: 2, altitudeM: 10_000 };
  assert.equal(heightFor(p, 'absolute'), 10_000);
  assert.equal(heightFor(p, 'clamp'), 0);
  assert.equal(heightFor(p, undefined), 0);
  assert.equal(heightFor({ latitude: 1, longitude: 2 }, 'absolute'), 0);
  assert.equal(heightFor({ ...p, altitudeM: -50 }, 'relative'), 0);
  assert.deepEqual(flattenPositions([p, { latitude: 3, longitude: 4 }], 'absolute'), [2, 1, 10_000, 4, 3, 0]);
  assert.equal(positionsValid([p]), false);
  assert.equal(positionsValid([p, { latitude: 91, longitude: 0 }]), false);
  assert.equal(positionsValid([p, { latitude: 3, longitude: 4 }]), true);
  const resolved = resolveStyle({ styleClass: 'aircraft', size: 10, icon: 'aircraft', rotationDegrees: 90 });
  assert.equal(iconSizePx(resolved, false), 22);
  assert.equal(iconSizePx({ ...resolved, sizePx: 100 }, false), 44);
  assert.equal(iconSizePx({ ...resolved, sizePx: 30 }, true), 30);
  assert.ok(
    Math.abs(headingToBillboardRotation(90) + Math.PI / 2) < 1e-12,
    'clockwise heading → counter-clockwise rotation',
  );
});

test('markers are depth-tested, so the far side of the globe does not show through it', () => {
  // Cesium's `disableDepthTestDistance` switches the depth test off within that distance
  // of the camera. Every marker type used to pass Number.POSITIVE_INFINITY, which means
  // "at every distance" — so objects behind the planet drew over it, and on a world view
  // the visible hemisphere was covered in things that are physically behind it.
  //
  // Zero is the whole fix. What happens on the near side is decided one level up by
  // Globe.depthTestAgainstTerrain, which renderer.ts already sets from the active terrain.
  assert.equal(MARKER_DEPTH_TEST_DISTANCE_M, 0);
  assert.equal(Number.isFinite(MARKER_DEPTH_TEST_DISTANCE_M), true, 'an infinite distance disables the test entirely');
});
