import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeWorldRenderer,
  type HostCapabilities,
  type PickResult,
  type RenderFeature,
  type ViewState,
  type WorldRenderer,
} from '@worldview/render-core';
import { DesktopRendererHost } from './renderer-host.js';
import type { RendererHostLike } from './renderer-host-like.js';

/**
 * A DOM small enough to hold the three things the host actually asks of one: make a
 * div, put it in the container, take it out again. The shell's tests run under
 * `node:test` with no jsdom (see shell.test.ts), so a real document is not available
 * and importing one for six properties would be a heavier dependency than the code
 * under test.
 */
interface FakeElement extends HTMLElement {
  readonly kids: FakeElement[];
}

function element(): FakeElement {
  const node = {
    kids: [] as FakeElement[],
    className: '',
    style: {} as CSSStyleDeclaration,
    parent: undefined as FakeElement | undefined,
    appendChild(child: FakeElement) {
      node.kids.push(child);
      (child as unknown as { parent?: FakeElement }).parent = node as unknown as FakeElement;
      return child;
    },
    remove() {
      const parent = (node as unknown as { parent?: FakeElement }).parent;
      if (!parent) return;
      const at = parent.kids.indexOf(node as unknown as FakeElement);
      if (at >= 0) parent.kids.splice(at, 1);
    },
    ownerDocument: { createElement: () => element() },
  };
  return node as unknown as FakeElement;
}

const CAPS: HostCapabilities = { webgl2: true };
const VIEW: ViewState = {
  center: { latitude: 10, longitude: 20 },
  altitudeM: 1_000_000,
  zoom: 5,
  headingDegrees: 0,
  pitchDegrees: -90,
};

function harness(
  opts: {
    caps?: HostCapabilities;
    mode?: '2D' | '3D' | 'AUTO';
    fail?: '2D' | '3D';
    initialView?: ViewState;
  } = {},
) {
  const r2d = new FakeWorldRenderer('2D');
  const r3d = new FakeWorldRenderer('3D', { withTerrain: true });
  const built: string[] = [];
  const make = (mode: '2D' | '3D', renderer: FakeWorldRenderer) => async (): Promise<WorldRenderer> => {
    built.push(mode);
    if (opts.fail === mode) throw new Error(`${mode} refused to construct`);
    return renderer;
  };
  const errors: Array<{ message: string; fatal: boolean }> = [];
  const host = new DesktopRendererHost({
    create2D: make('2D', r2d),
    create3D: make('3D', r3d),
    capabilities: opts.caps ?? CAPS,
    onError: (e) => errors.push(e),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.initialView ? { initialView: opts.initialView } : {}),
  });
  return { host, r2d, r3d, built, errors, container: element() };
}

const attribution = [{ id: 'osm', text: '© OpenStreetMap', onScreen: true }];
const feature = (id: string): RenderFeature => ({
  id,
  layer: 'test',
  geometry: { kind: 'point', position: { latitude: 1, longitude: 2 } },
  style: { styleClass: 'test', color: '#fff' },
  interactive: true,
  priority: 0,
});
const pick = (featureId: string): PickResult => ({
  featureId,
  position: { latitude: 0, longitude: 0 },
  screen: { x: 0, y: 0 },
});

test('mounts only the requested mode: the other renderer is never constructed', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  assert.deepEqual(h.built, ['2D']);
  assert.equal(h.host.activeMode(), '2D');
  assert.equal(h.r3d.container, undefined, '3D renderer must not be constructed until 3D is asked for');
  assert.equal(h.container.kids.length, 1, 'one pane per constructed renderer');
});

test('AUTO without WebGL2 resolves to 2D and reports 3D unsupported', async () => {
  const h = harness({ caps: { webgl2: false }, mode: 'AUTO' });
  await h.host.mount(h.container);
  assert.equal(h.host.activeMode(), '2D');
  assert.equal(h.host.supportsMode('3D'), false);
  assert.equal(h.host.supportsMode('2D'), true);
});

test('switching modes suspends the renderer being left and hides its pane', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  h.host.setMode('3D');
  await new Promise(setImmediate);

  assert.equal(h.host.activeMode(), '3D');
  assert.equal(h.r2d.suspended, true, 'the hidden renderer must stop doing GPU work');
  assert.equal(h.r3d.suspended, false);
  assert.equal(h.container.kids.length, 2);
  assert.equal(h.container.kids[0]!.style.display, 'none', '2D pane hidden');
  assert.equal(h.container.kids[1]!.style.display, '', '3D pane shown');
});

test('a mode switch carries features, selection, attribution and view onto the new renderer', async () => {
  const h = harness({ mode: '2D', initialView: VIEW });
  await h.host.mount(h.container);
  h.host.setFeatures({ upsert: [feature('a'), feature('b')], remove: [] });
  h.host.setFeatures({ upsert: [], remove: ['a'] });
  h.host.select('b');
  h.host.setAttribution(attribution);

  h.host.setMode('3D');
  await new Promise(setImmediate);

  assert.deepEqual([...h.r3d.features.keys()], ['b'], 'removed features must not reappear on the new renderer');
  assert.equal(h.r3d.selected, 'b');
  assert.deepEqual(h.r3d.attribution, attribution);
  assert.equal(h.r3d.getView().center.latitude, VIEW.center.latitude);
});

test('basemaps are per mode; terrain is applied only to 3D', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  const flat = { kind: 'none' as const, id: 'flat' };
  const globe = { kind: 'cesium-natural-earth' as const, id: 'ne', attribution: 'Natural Earth' };
  await h.host.setBasemap(flat);
  await h.host.setBasemap(globe, '3D');
  await h.host.setTerrain({ kind: 'ellipsoid' });

  assert.deepEqual(h.r2d.basemap, flat);
  assert.equal(h.r3d.basemap, undefined, '3D basemap must wait until 3D is built, not construct it early');

  h.host.setMode('3D');
  await new Promise(setImmediate);
  assert.deepEqual(h.r3d.basemap, globe);
  assert.deepEqual(h.r3d.terrain, { kind: 'ellipsoid' });
  assert.equal(h.r2d.terrain, undefined);
});

test('raster overlays reach both renderers, the one built later included (ADR-008)', async () => {
  const h = harness({ mode: '2D', initialView: VIEW });
  const overlays = [
    {
      id: 'a:roads',
      providerId: 'a',
      name: 'Roads',
      attribution: 'A',
      kind: 'wms' as const,
      url: 'https://w.example/wms',
      layers: 'roads',
    },
  ];
  h.host.setOverlays(overlays);
  await h.host.mount(h.container);
  assert.deepEqual(h.r2d.overlays, overlays, 'given before mount, applied on the first renderer');
  h.host.setMode('3D');
  await new Promise(setImmediate);
  assert.deepEqual(h.r3d.overlays, overlays, 'carried onto the renderer built for the switch');
  h.host.setOverlays([]);
  assert.deepEqual(h.r2d.overlays, [], 'the hidden renderer is kept current too');
  assert.deepEqual(h.r3d.overlays, []);
});

test('state set before mount is replayed onto the first renderer', async () => {
  const h = harness({ mode: '2D' });
  h.host.setFeatures({ upsert: [feature('a')], remove: [] });
  h.host.select('a');
  h.host.setAttribution(attribution);
  await h.host.mount(h.container);

  assert.deepEqual([...h.r2d.features.keys()], ['a']);
  assert.equal(h.r2d.selected, 'a');
  assert.deepEqual(h.r2d.attribution, attribution);
});

test('a renderer that will not construct is reported and the mode does not change', async () => {
  const h = harness({ mode: '2D', fail: '3D' });
  await h.host.mount(h.container);
  const seen: Array<{ message: string; fatal: boolean }> = [];
  h.host.on('error', (e) => seen.push(e));

  h.host.setMode('3D');
  await new Promise(setImmediate);

  assert.equal(h.host.activeMode(), '2D', 'claiming 3D while showing nothing is worse than staying in 2D');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!.message, /3D refused to construct/);
  assert.equal(seen.length, 1, 'the failure reaches listeners, not only the options callback');
  assert.equal(h.container.kids.length, 1, 'the orphaned pane is removed');
});

test('a failed construction can be retried', async () => {
  let attempts = 0;
  const r3d = new FakeWorldRenderer('3D', { withTerrain: true });
  const host = new DesktopRendererHost({
    create2D: async () => new FakeWorldRenderer('2D'),
    create3D: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
      return r3d;
    },
    capabilities: CAPS,
    mode: '2D',
  });
  const container = element();
  await host.mount(container);
  host.setMode('3D');
  await new Promise(setImmediate);
  assert.equal(host.activeMode(), '2D');
  host.setMode('3D');
  await new Promise(setImmediate);
  assert.equal(host.activeMode(), '3D', 'a transient construction failure must not poison the mode forever');
});

test('events from the hidden renderer are not forwarded to the shell', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  h.host.setMode('3D');
  await new Promise(setImmediate);

  const picks: unknown[] = [];
  h.host.on('pick', (p) => picks.push(p));
  h.r2d.simulatePick(pick('ghost'));
  assert.deepEqual(picks, [], 'a suspended renderer must not be able to change the selection');

  h.r3d.simulatePick(pick('real'));
  assert.equal(picks.length, 1);
});

test('the hidden renderer cannot overwrite the view that a switch will restore', async () => {
  const h = harness({ mode: '2D', initialView: VIEW });
  await h.host.mount(h.container);
  h.host.setMode('3D');
  await new Promise(setImmediate);
  h.r3d.setView({ center: { latitude: 45, longitude: 45 } });

  // A map that is merely hidden can still settle and fire moveend.
  h.r2d.emit('viewChanged', {
    center: { latitude: -80, longitude: -80 },
    altitudeM: 100,
    zoom: 14,
    headingDegrees: 0,
    pitchDegrees: -90,
  });

  h.host.setMode('2D');
  await new Promise(setImmediate);
  assert.equal(
    h.r2d.getView().center.latitude,
    45,
    'the view carried back must come from the renderer that was visible',
  );
});

test('rapid mode switches settle on the last one requested', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  h.host.setMode('3D');
  h.host.setMode('2D');
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.equal(h.host.activeMode(), '2D');
  assert.equal(h.r2d.suspended, false, 'the mode we settled on must be running');
});

test('unmount disposes both renderers and empties the container', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  h.host.setMode('3D');
  await new Promise(setImmediate);

  h.host.unmount();
  assert.equal(h.r2d.disposed, true);
  assert.equal(h.r3d.disposed, true);
  assert.equal(h.container.kids.length, 0);
  assert.equal(h.r2d.listenerCount('pick'), 0, 'listeners are released, not left holding the host');
});

test('flyTo records the view it produced so a later switch keeps it', async () => {
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  await h.host.flyTo({ position: { latitude: 51.5, longitude: -0.12 }, zoom: 11 });
  h.host.setMode('3D');
  await new Promise(setImmediate);
  assert.equal(Math.round(h.r3d.getView().center.latitude * 10) / 10, 51.5);
});

/**
 * The toggle showed the wrong mode after every switch, and this is the shape of why.
 *
 * `setMode` returns immediately; activation imports, constructs and mounts a renderer, so
 * it finishes microtasks or more later. actions.setMode called setMode and then read
 * activeMode() on the very next line, which is necessarily the mode being *left*, and
 * dispatched that into the store. Clicking 2D on a 3D map left the control reading 3D
 * whether or not the switch had worked — so a successful switch and a failed one looked
 * identical, which is how a blank 2D map went unexplained.
 *
 * The first assertion is the bug: synchronous reads are stale by construction. The second
 * is the fix: the host says so when it is true.
 */
test('the host announces a mode switch, because activeMode() is stale until it lands', async () => {
  const h = harness({ mode: '3D' });
  await h.host.mount(h.container);

  const announced: Array<{ mode: '2D' | '3D'; requested: string }> = [];
  h.host.on('modeChanged', (payload) => announced.push(payload));

  h.host.setMode('2D');
  assert.equal(h.host.activeMode(), '3D', 'reading the mode synchronously gives the one being left');
  assert.deepEqual(announced, [], 'nothing is announced until the renderer is actually up');

  await new Promise(setImmediate);

  assert.equal(h.host.activeMode(), '2D');
  assert.deepEqual(announced, [{ mode: '2D', requested: '2D' }], 'the switch is announced once it has landed');
});

test('a mode switch that fails to construct is not announced', async () => {
  const h = harness({ mode: '2D', fail: '3D' });
  await h.host.mount(h.container);

  const announced: unknown[] = [];
  const errors: Array<{ message: string; fatal: boolean }> = [];
  h.host.on('modeChanged', (p) => announced.push(p));
  h.host.on('error', (e) => errors.push(e));

  h.host.setMode('3D');
  await new Promise(setImmediate);

  assert.deepEqual(announced, [], 'announcing a mode whose renderer never built would be a lie');
  assert.equal(h.host.activeMode(), '2D', 'the mode does not change when the renderer will not construct');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /3D refused to construct/);
  assert.equal(errors[0]!.fatal, true);
});

/**
 * A basemap that never finishes loading must not take the world's data with it.
 *
 * The default 2D basemap on a fresh installation is a pmtiles pack that is not installed,
 * so its style never loads and `setBasemap` never settled. The feature push, attribution,
 * selection and camera all sat behind that await, so the 2D map came up with no backdrop
 * AND no objects — indistinguishable from a dead renderer, and silent.
 */
test('features reach the renderer even when the basemap never loads', async () => {
  const h = harness({ mode: '3D' });
  await h.host.mount(h.container);
  h.host.setFeatures({
    upsert: [{ id: 'f1', kind: 'point', position: { latitude: 1, longitude: 2 }, style: {} } as never],
    remove: [],
  });
  await new Promise(setImmediate);

  // A basemap whose promise never settles — exactly what an absent pmtiles pack produced.
  h.r2d.setBasemap = () => new Promise<void>(() => undefined);

  h.host.setBasemap({ kind: 'none', id: 'none' } as never, '2D');
  h.host.setMode('2D');
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.equal(h.r2d.features.size > 0, true, 'the objects are drawn whether or not a backdrop arrives');
  assert.equal(h.host.activeMode(), '2D', 'and the mode still completes');
});

test('the host surface the shell codes against can actually reach the basemap and terrain', async () => {
  // This is the guard for the defect that cost the longest single stretch of this project.
  // `setBasemap` and `setTerrain` were implemented here and covered by the test above, and
  // both were missing from `RendererHostLike` — the only type the shell has. So no shell
  // code could call them and none did: choosing Esri World Imagery in Settings moved the
  // credit line (the shell computes that from the setting itself) and left the imagery
  // exactly as it was. That reads as a provider failing over and over, and it sent the
  // investigation through CORS, custom-scheme origins, CSP headers, layer ordering and
  // tile-failure fallbacks — none of which were involved, because nothing had ever asked
  // for a different basemap.
  //
  // The assertion is deliberately made through a `RendererHostLike`-typed reference: if
  // either method leaves that interface again this stops compiling, and if either stops
  // reaching the renderer it fails at run time.
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  const shellView: RendererHostLike = h.host;

  const basemap = { kind: 'none' as const, id: 'flat' };
  await shellView.setBasemap?.(basemap);
  assert.deepEqual(h.r2d.basemap, basemap, 'the shell can change the basemap');

  h.host.setMode('3D');
  await new Promise(setImmediate);
  const terrain = { kind: 'ellipsoid' as const };
  await shellView.setTerrain?.(terrain);
  assert.deepEqual(h.r3d.terrain, terrain, 'the shell can change the terrain');

  // And the renderer's own feature ceiling, which the shell's performance governor needs
  // for the same reason: implemented here, useless unless the interface exposes it.
  assert.equal(typeof shellView.maxFeatures?.(), 'number');
});

test('the host forwards frame samples from the active renderer, which is what the governor runs on', async () => {
  // `frame` was missing from the host's list of forwarded events, so the shell's performance
  // governor and its `[perf]` log never received a sample in the desktop app. They had been
  // tested against render-core's RendererHost, which the app does not use. This goes through
  // `RendererHostLike`, the surface the shell actually has.
  const h = harness({ mode: '2D' });
  await h.host.mount(h.container);
  const shellView: RendererHostLike = h.host;
  const seen: number[] = [];
  shellView.on('frame', (f) => seen.push(f.fps));
  h.r2d.emit('frame', { fps: 57, featureCount: 1200 });
  assert.deepEqual(seen, [57], 'the active renderer is heard');

  h.host.setMode('3D');
  await new Promise(setImmediate);
  h.r2d.emit('frame', { fps: 3, featureCount: 1200 });
  assert.deepEqual(seen, [57], 'a hidden renderer does not speak for the one on screen');
  h.r3d.emit('frame', { fps: 60, featureCount: 1200 });
  assert.deepEqual(seen, [57, 60]);
});
