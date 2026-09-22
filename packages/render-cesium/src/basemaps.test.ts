import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCesiumStackRegistry,
  indexMapSources,
  MapStackController,
  stackIdForBasemap,
  ESRI_STACK_ID,
  GOOGLE_3D_STACK_ID,
  ION_BING_STACK_ID,
  NATURAL_EARTH_STACK_ID,
  NONE_STACK_ID,
  OSM_STACK_ID,
  type MapStackRegistry,
  type MapStackSource,
  type MapStackState,
} from './basemaps.js';
import { createEsriWorldImagery, ESRI_MAX_LEVEL, ESRI_WORLD_IMAGERY_TILE_URL } from './imagery.js';
import { createFakeCesium, fakeImageryProvider, FakeViewer, type FakeCesium } from './testing/fake-cesium.js';
import { createMapCredits } from './attribution.js';
import type { ImageryLayerLike, ImageryProviderLike } from './cesium-like.js';

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function harness(registry: MapStackRegistry, cesium: FakeCesium = createFakeCesium()) {
  const viewer = new FakeViewer({} as Element, {});
  const changes: MapStackState[] = [];
  const errors: string[] = [];
  const created: Array<ImageryLayerLike & { provider?: ImageryProviderLike; destroyed: boolean }> = [];
  const credits = createMapCredits(viewer.creditDisplay, (html, onScreen) => new cesium.Credit(html, onScreen));
  const controller = new MapStackController(viewer, {
    registry,
    createImageryLayer: (provider) => {
      const layer = {
        show: true,
        alpha: 1,
        provider,
        destroyed: false,
        destroy() {
          layer.destroyed = true;
        },
        isDestroyed() {
          return layer.destroyed;
        },
      };
      created.push(layer);
      return layer;
    },
    credits,
    onChange: (s) => changes.push(s),
    onError: (m) => errors.push(m),
  });
  return { viewer, controller, changes, errors, created, credits, cesium };
}

test('registry: Natural Earth II is the default and recovery stack; conditional/keyed stacks are opt-in', () => {
  const cesium = createFakeCesium();
  const reg = buildCesiumStackRegistry(cesium);
  assert.equal(reg.defaultId, NATURAL_EARTH_STACK_ID);
  assert.equal(reg.recoveryId, NATURAL_EARTH_STACK_ID);
  const byId = indexMapSources(reg.sources);
  assert.equal(byId.get(NATURAL_EARTH_STACK_ID)!.descriptor.review, 'approved');
  assert.equal(byId.get(NATURAL_EARTH_STACK_ID)!.descriptor.offlineCapable, true);
  assert.equal(byId.get(ESRI_STACK_ID)!.descriptor.review, 'conditional');
  assert.equal(byId.get(OSM_STACK_ID)!.descriptor.review, 'conditional');
  assert.equal(byId.get(ION_BING_STACK_ID)!.available, false, 'ion needs a token');
  assert.equal(byId.get(GOOGLE_3D_STACK_ID)!.available, false, 'google needs a key');
  assert.match(byId.get(GOOGLE_3D_STACK_ID)!.unavailableReason ?? '', /own Google Maps Platform key/);
  assert.equal(byId.get(GOOGLE_3D_STACK_ID)!.createTileset, undefined, 'no tileset factory without credentials');
  assert.equal(byId.get(ESRI_STACK_ID)!.constructionFallback?.id, NATURAL_EARTH_STACK_ID);
  assert.equal(byId.get(ESRI_STACK_ID)!.tileFailureFallback?.threshold, 2);

  const withKeys = buildCesiumStackRegistry(cesium, {
    ionToken: 'tok',
    google: { credentialRef: 'google-maps', resolveCredential: async () => 'k' },
  });
  const keyed = indexMapSources(withKeys.sources);
  assert.equal(keyed.get(ION_BING_STACK_ID)!.available, true);
  assert.equal(keyed.get(GOOGLE_3D_STACK_ID)!.available, true);
  assert.equal(withKeys.defaultId, NATURAL_EARTH_STACK_ID, 'credentials never change the default');
});

test('indexMapSources rejects duplicate ids, unknown fallbacks and fallback cycles', () => {
  const src = (id: string, fallback?: string): MapStackSource => ({
    descriptor: { id, label: id, kind: 'imagery', attribution: '', review: 'approved', offlineCapable: true },
    available: true,
    imagery: () => fakeImageryProvider(id),
    ...(fallback ? { constructionFallback: { id: fallback, message: 'x' } } : {}),
  });
  assert.throws(() => indexMapSources([src('a'), src('a')]), /unique/);
  assert.throws(() => indexMapSources([src('a', 'zzz')]), /Unknown map fallback/);
  assert.throws(() => indexMapSources([src('a', 'b'), src('b', 'a')]), /cycle/);
  assert.equal(indexMapSources([src('a', 'b'), src('b')]).size, 2);
});

test('controller: activates the default stack, adds the imagery layer at index 0 and shows the globe with the stack credit', async () => {
  const h = harness(buildCesiumStackRegistry(createFakeCesium()));
  const state = await h.controller.setStack(NATURAL_EARTH_STACK_ID);
  assert.equal(state.status, 'ready');
  assert.equal(state.activeId, NATURAL_EARTH_STACK_ID);
  assert.equal(h.viewer.imageryLayers.length, 1);
  assert.equal(h.viewer.scene.globe.show, true);
  assert.match(h.credits.current ?? '', /Natural Earth II/);
  assert.deepEqual(
    h.changes.map((c) => c.status),
    ['switching', 'ready'],
  );
  assert.ok(h.viewer.scene.renderRequests >= 1);
  // Re-selecting the same stack keeps the live layer (no rebuild → no blank globe).
  await h.controller.setStack(NATURAL_EARTH_STACK_ID);
  assert.equal(h.created.length, 1);
});

test('controller: a construction failure falls back to Natural Earth with a message; a stack error recovers to the recovery stack', async () => {
  const cesium = createFakeCesium({
    esri: () => {
      throw new Error('esri down');
    },
  });
  const h = harness(buildCesiumStackRegistry(cesium), cesium);
  const state = await h.controller.setStack(ESRI_STACK_ID);
  assert.equal(state.activeId, NATURAL_EARTH_STACK_ID, 'effective stack is the fallback');
  assert.match(state.lastError ?? '', /Esri World Imagery is unavailable/);
  // The reason the provider gave has to survive into the message. Reporting only
  // "unavailable" is what made two different online basemaps failing look identical and
  // undiagnosable from the application itself.
  assert.deepEqual(h.errors, ['Esri World Imagery is unavailable; showing Natural Earth II — esri down']);
  assert.match(h.credits.current ?? '', /Natural Earth/);

  // A stack without a construction fallback whose factory throws → recovery stack.
  const cesium2 = createFakeCesium({
    osm: () => {
      throw new Error('osm blocked');
    },
  });
  const h2 = harness(buildCesiumStackRegistry(cesium2), cesium2);
  const s2 = await h2.controller.setStack(OSM_STACK_ID);
  assert.equal(s2.activeId, NATURAL_EARTH_STACK_ID, 'recovered onto Natural Earth');
  assert.equal(s2.lastError, 'osm blocked');
  assert.equal(h2.changes.at(-1)!.status, 'error', 'listeners learn the requested stack failed');
  assert.deepEqual(h2.errors, ['osm blocked']);
  assert.equal(h2.viewer.imageryLayers.length, 1);
});

test('controller: generation counter — a slow older switch never overrides a newer one', async () => {
  // The slow stack has to be one that genuinely waits on the network. Esri used to be it,
  // back when building it meant fetching a service document before a tile could be
  // addressed; now that it is a plain tile template, the ion-backed stacks are the only
  // ones that await anything.
  let releaseIon: (() => void) | undefined;
  const ionProvider = fakeImageryProvider('ion:3');
  const cesium = createFakeCesium({
    ion: () =>
      new Promise((resolve) => {
        releaseIon = () => resolve(ionProvider);
      }),
  });
  const h = harness(buildCesiumStackRegistry(cesium, { ionToken: 'tok' }), cesium);
  const slow = h.controller.setStack(ION_BING_STACK_ID);
  const fast = await h.controller.setStack(OSM_STACK_ID);
  assert.equal(fast.activeId, OSM_STACK_ID);
  releaseIon!();
  const late = await slow;
  assert.equal(late.activeId, OSM_STACK_ID, 'late result ignored');
  assert.equal(h.viewer.imageryLayers.length, 1);
  assert.equal(h.created.length, 1);
  assert.equal(h.credits.current, '© OpenStreetMap contributors');
});

test('controller: repeated tile failures switch to the fallback stack once and report it', async () => {
  const esri = fakeImageryProvider('esri');
  const cesium = createFakeCesium({ esri: () => esri });
  const h = harness(buildCesiumStackRegistry(cesium), cesium);
  await h.controller.setStack(ESRI_STACK_ID);
  assert.equal(h.controller.getActiveId(), ESRI_STACK_ID);
  esri.errorEvent.raise({ timesRetried: 0 });
  await settle();
  assert.equal(h.controller.getActiveId(), ESRI_STACK_ID, 'below threshold');
  esri.errorEvent.raise({ timesRetried: 1 });
  await settle();
  assert.equal(h.controller.getActiveId(), NATURAL_EARTH_STACK_ID);
  assert.equal(h.controller.getState().lastError, 'Esri World Imagery tile requests failed; showing Natural Earth II');
  assert.equal(h.changes.at(-1)!.status, 'error');
  assert.equal(esri.errorEvent.size, 0, 'listener removed after the switch');
  esri.errorEvent.raise({ timesRetried: 5 });
  await settle();
  assert.equal(h.errors.filter((e) => /tile requests failed/.test(e)).length, 1, 'only one fallback');
});

test('controller: unavailable stacks refuse with the setup reason; Google 3D constructs only with a resolved key and hides the globe', async () => {
  const cesium = createFakeCesium();
  const h = harness(buildCesiumStackRegistry(cesium), cesium);
  const refused = await h.controller.setStack(GOOGLE_3D_STACK_ID);
  assert.equal(refused.status, 'error');
  assert.match(refused.lastError ?? '', /own Google Maps Platform key/);
  assert.equal(h.viewer.scene.primitives.length, 0, 'nothing constructed');

  const keys: string[] = [];
  const cesium2 = createFakeCesium({
    google: async (key) => {
      keys.push(key ?? '');
      const t = {
        show: false,
        destroyed: false,
        destroy() {
          t.destroyed = true;
        },
        isDestroyed() {
          return t.destroyed;
        },
      };
      return t;
    },
  });
  const h2 = harness(
    buildCesiumStackRegistry(cesium2, {
      google: {
        credentialRef: 'cred:google',
        resolveCredential: async (ref) => (ref === 'cred:google' ? 'secret-key' : undefined),
      },
    }),
    cesium2,
  );
  await h2.controller.setStack(NATURAL_EARTH_STACK_ID);
  const g = await h2.controller.setStack(GOOGLE_3D_STACK_ID);
  assert.equal(g.status, 'ready');
  assert.deepEqual(keys, ['secret-key']);
  assert.equal(h2.viewer.scene.globe.show, false, 'photogrammetry replaces the globe');
  assert.equal(h2.viewer.imageryLayers.length, 0);
  assert.equal(h2.credits.current, 'Google');
  await h2.controller.setStack(NATURAL_EARTH_STACK_ID);
  assert.equal(h2.viewer.scene.globe.show, true);
  assert.equal(
    (h2.viewer.scene.primitives.items[0] as { show: boolean }).show,
    false,
    'tileset hidden, kept for reuse',
  );

  const none = await h2.controller.setStack(NONE_STACK_ID);
  assert.equal(none.status, 'ready');
  assert.equal(h2.viewer.imageryLayers.length, 0);
  assert.equal(h2.viewer.scene.globe.show, true);
  assert.equal(h2.credits.current, null);
});

test('controller: BasemapDescriptor mapping registers XYZ sources on the fly and rejects 2D-only kinds', async () => {
  const cesium = createFakeCesium();
  const h = harness(buildCesiumStackRegistry(cesium), cesium);
  const c = h.controller;
  assert.deepEqual(stackIdForBasemap(c, cesium, { kind: 'cesium-natural-earth', id: 'ne', attribution: '' }), {
    stackId: NATURAL_EARTH_STACK_ID,
  });
  assert.deepEqual(stackIdForBasemap(c, cesium, { kind: 'esri-world-imagery', id: 'esri', attribution: '' }), {
    stackId: ESRI_STACK_ID,
  });
  assert.deepEqual(stackIdForBasemap(c, cesium, { kind: 'cesium-ion', id: 'bing', assetId: 3, attribution: '' }), {
    stackId: ION_BING_STACK_ID,
  });
  assert.ok(
    'unsupported' in stackIdForBasemap(c, cesium, { kind: 'cesium-ion', id: 'x', assetId: 42, attribution: '' }),
  );
  assert.ok(
    'unsupported' in
      stackIdForBasemap(c, cesium, {
        kind: 'pmtiles',
        id: 'pack',
        url: 'x.pmtiles',
        styleId: 'worldview-dark',
        attribution: '',
      }),
  );
  assert.ok(
    'unsupported' in
      stackIdForBasemap(c, cesium, {
        kind: 'vector-style',
        id: 'v',
        styleUrl: 'https://x/style.json',
        attribution: '',
      }),
  );
  const xyz = stackIdForBasemap(c, cesium, {
    kind: 'raster-xyz',
    id: 'my-tiles',
    url: 'https://tiles.example/{z}/{x}/{y}.png',
    attribution: 'Example tiles',
    maxZoom: 12,
  });
  assert.deepEqual(xyz, { stackId: 'raster-xyz:my-tiles' });
  const stack = c.getStacks().find((s) => s.id === 'raster-xyz:my-tiles')!;
  assert.equal(stack.attribution, 'Example tiles');
  assert.equal(stack.offlineCapable, false);
  const state = await c.setStack('raster-xyz:my-tiles');
  assert.equal(state.activeId, 'raster-xyz:my-tiles');
  assert.equal(h.credits.current, 'Example tiles');
  const osmXyz = stackIdForBasemap(c, cesium, {
    kind: 'raster-xyz',
    id: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  });
  assert.equal(c.getStacks().find((s) => s.id === (osmXyz as { stackId: string }).stackId)!.review, 'conditional');
  const unknown = await c.setStack('does-not-exist');
  assert.equal(unknown.status, 'error');
});

test('controller: destroy removes the layer, credits and disposes cached providers; later calls are inert', async () => {
  const ne = fakeImageryProvider('ne');
  const cesium = createFakeCesium({ naturalEarth: async () => ne });
  const h = harness(buildCesiumStackRegistry(cesium), cesium);
  await h.controller.setStack(NATURAL_EARTH_STACK_ID);
  h.controller.destroy();
  await settle();
  assert.equal(h.viewer.imageryLayers.length, 0);
  assert.equal(h.created[0]!.destroyed, true);
  assert.equal(ne.destroyed, true);
  assert.equal(h.credits.current, null);
  const after = await h.controller.setStack(OSM_STACK_ID);
  assert.equal(after.activeId, NATURAL_EARTH_STACK_ID);
});

test('imagery: Esri World Imagery is a deep tile template, built without a metadata round-trip', () => {
  // The whole point of the change this locks in. `ArcGisMapServerImageryProvider.fromUrl`
  // could not produce a provider without first fetching `?f=json`, so an operator whose
  // network refused that one request silently lost the only basemap in the build with
  // more than three zoom levels and was left looking at a smear of Natural Earth II.
  // A tile template needs no such request: the factory is synchronous, which is the
  // machine-checkable form of "there is nothing here that can fail before a tile is asked
  // for". If someone reintroduces the service-document path, this stops being a provider
  // and starts being a promise, and this assertion is what says so.
  const cesium = createFakeCesium();
  const provider = createEsriWorldImagery(cesium) as { url?: string; maximumLevel?: number } & object;
  assert.equal(typeof (provider as { then?: unknown }).then, 'undefined', 'construction is synchronous');
  assert.equal(provider.url, ESRI_WORLD_IMAGERY_TILE_URL);
  assert.match(ESRI_WORLD_IMAGERY_TILE_URL, /\/tile\/\{z\}\/\{y\}\/\{x\}$/);
  // ~0.3 m/px: the level at which a house has a roof. Anything shallower and the
  // "zoom in to see a building" case this basemap exists for does not work.
  assert.equal(provider.maximumLevel, ESRI_MAX_LEVEL);
  assert.ok(ESRI_MAX_LEVEL >= 19, 'a basemap that stops short of level 19 cannot resolve a building');
});
