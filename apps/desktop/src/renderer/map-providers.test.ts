import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapProviderList } from '@worldview/ipc-contract';
import { resolveMapProviders } from '@worldview/render-core';
import {
  basemapChoices,
  basemapForMode,
  missingBasemapReason,
  overlaysToDraw,
  resolveMapProvider,
  selectBasemap,
  selectTerrain,
  sourceBasemapFor,
  sourceBasemapId,
  terrainChoices,
  terrainFor,
} from './map-providers.js';

function list(): MapProviderList {
  const resolved = resolveMapProviders({ credentials: [], offlineBasemapAvailable: false, online: true });
  return {
    basemaps: resolved.filter((e) => e.kind === 'basemap'),
    terrains: resolved.filter((e) => e.kind === 'terrain'),
    activeBasemapId: 'natural-earth',
    activeTerrainId: 'ellipsoid',
  };
}

test('shell map providers: before the first response the shell names nothing it cannot back up', () => {
  assert.equal(selectBasemap(null, 'natural-earth'), undefined);
  assert.equal(selectTerrain(null, 'ellipsoid'), undefined);
  assert.deepEqual(
    basemapChoices(null, 'natural-earth').map((c) => c.id),
    ['natural-earth'],
  );
});

test('shell map providers: a selected entry carries the runtime attribution and availability', () => {
  const chosen = selectBasemap(list(), 'natural-earth');
  assert.equal(chosen?.name, 'Natural Earth II (bundled)');
  assert.match(chosen?.attribution ?? '', /Natural Earth II/);
  assert.equal(chosen?.available, true);

  const gated = selectBasemap(list(), 'cesium-ion-bing');
  assert.equal(gated?.available, false);
  assert.match(gated?.unavailableReason ?? '', /cesium\.ionToken/);
});

test('shell map providers: an id the runtime did not list stays selected rather than being rewritten', () => {
  const choices = basemapChoices(list(), 'operator-custom-style');
  assert.equal(choices[0]?.id, 'operator-custom-style');
  assert.match(choices[0]?.name ?? '', /configured by the runtime/);
  assert.equal(choices.filter((c) => c.id === 'operator-custom-style').length, 1);

  const known = basemapChoices(list(), 'natural-earth');
  assert.equal(known.filter((c) => c.id === 'natural-earth').length, 1, 'a listed id is not duplicated');
});

test('shell map providers: a choice carries what the tile cache may do, so Settings can offer the world preload', () => {
  // The Settings dialog decides whether to offer "Preload the whole globe" from the chosen
  // basemap's tileCache block. The choice used to drop it, so the switch was never enabled.
  const esri = basemapChoices(list(), 'esri-world-imagery').find((c) => c.id === 'esri-world-imagery');
  assert.equal(esri?.tileCache?.worldPreload, 'operator-decides');
  const osm = basemapChoices(list(), 'natural-earth').find((c) => c.id === 'osm-raster');
  assert.ok(osm, 'OpenStreetMap is listed');
  assert.equal(osm.tileCache, undefined, 'OSM tile policy: no cache, no preload');

  const offline = resolveMapProviders({ online: false, cachedTileSources: ['esri-world-imagery'] });
  const offlineList = { ...list(), basemaps: offline.filter((e) => e.kind === 'basemap') };
  const cached = basemapChoices(offlineList, 'esri-world-imagery').find((c) => c.id === 'esri-world-imagery');
  assert.equal(cached?.available, true);
  assert.match(cached?.availableNote ?? '', /cached/);
});

test('shell map providers: unavailable entries are still offered, so the reason is visible', () => {
  const choices = basemapChoices(list(), 'natural-earth');
  const gated = choices.find((c) => c.id === 'cesium-ion-bing');
  assert.ok(gated, 'the picker lists it');
  assert.equal(gated.available, false);
  assert.ok(gated.unavailableReason, 'with a reason the dialog can show');
  assert.deepEqual(
    terrainChoices(list(), 'ellipsoid')
      .map((c) => c.id)
      .slice(0, 1),
    ['ellipsoid'],
  );
});

test('resolveMapProvider: the configured id yields the descriptor the renderer needs', () => {
  // `selectBasemap` / `selectTerrain` narrow to what the UI shows and deliberately drop the
  // descriptor, so the shell had a selector for the credit line and none for the thing that
  // changes the map — which is half of why changing the basemap in Settings did nothing but
  // move the credit. Returning nothing until the runtime's list arrives is the point: the
  // shell must never invent a descriptor for an id it cannot resolve.
  const l = list();
  const basemap = resolveMapProvider(l, 'basemap', 'natural-earth');
  const terrain = resolveMapProvider(l, 'terrain', 'reearth-terrain');
  assert.ok(basemap?.descriptor.kind, 'the bundled basemap resolves to a descriptor');
  assert.ok(terrain?.descriptor.kind, 'the keyless terrain resolves to a descriptor');
  assert.equal(resolveMapProvider(l, 'basemap', 'reearth-terrain'), undefined, 'kinds do not cross over');
  assert.equal(resolveMapProvider(null, 'basemap', 'natural-earth'), undefined, 'nothing before the list arrives');
  assert.equal(resolveMapProvider(l, 'basemap', undefined), undefined);
  assert.equal(resolveMapProvider(l, 'basemap', 'not-in-the-catalog'), undefined);
});

/** The same list under different installation conditions. */
function listWhen(opts: { online: boolean; pack: boolean }): MapProviderList {
  const resolved = resolveMapProviders({ credentials: [], offlineBasemapAvailable: opts.pack, online: opts.online });
  return {
    basemaps: resolved.filter((e) => e.kind === 'basemap'),
    terrains: resolved.filter((e) => e.kind === 'terrain'),
    activeBasemapId: 'natural-earth',
    activeTerrainId: 'ellipsoid',
  };
}

test('basemapForMode: never hands a renderer something it cannot show', () => {
  // Settings hold one basemapId; the catalog entries are per mode and can be unavailable.
  // Natural Earth II is a Cesium imagery stack and 3D-only. The 2D default is a PMTiles
  // pack a fresh installation does not have. Wiring the setting straight to the renderer
  // would have handed MapLibre one or the other on every default install.
  const fresh = listWhen({ online: true, pack: false });
  assert.equal(basemapForMode(fresh, 'natural-earth', '3D')?.id, 'natural-earth', 'kept where it works');
  assert.equal(
    basemapForMode(fresh, 'natural-earth', '2D')?.id,
    'esri-world-imagery',
    'the preferred basemap, rather than a pack that is not installed (a 10 s style timeout and a toast)',
  );
  const withPack = listWhen({ online: true, pack: true });
  assert.equal(basemapForMode(withPack, 'natural-earth', '2D')?.id, 'esri-world-imagery', 'Esri first while online');
  const offlinePack = listWhen({ online: false, pack: true });
  assert.equal(basemapForMode(offlinePack, 'natural-earth', '2D')?.id, 'worldview-dark', 'the pack offline');

  // An entry that serves both modes is kept in both, which is the point of choosing it.
  assert.equal(basemapForMode(fresh, 'esri-world-imagery', '2D')?.id, 'esri-world-imagery');
  assert.equal(basemapForMode(fresh, 'esri-world-imagery', '3D')?.id, 'esri-world-imagery');

  // Offline, a network basemap gives way to what can actually be drawn — without the
  // setting being rewritten, so coming back online restores it.
  const offline = listWhen({ online: false, pack: false });
  assert.equal(basemapForMode(offline, 'esri-world-imagery', '3D')?.id, 'natural-earth');
  assert.equal(basemapForMode(offline, 'esri-world-imagery', '2D'), undefined);

  // An unknown id falls back rather than being invented, and nothing resolves before the
  // runtime's list has arrived.
  assert.equal(basemapForMode(fresh, 'not-in-the-catalog', '3D')?.id, 'esri-world-imagery');
  assert.equal(basemapForMode(null, 'natural-earth', '3D'), undefined);
});

test('terrainFor: an unavailable terrain gives way to the ellipsoid, never to nothing', () => {
  // This is what makes a network terrain safe to select — and safe to make the default one
  // day — for someone who opens the app with no connection: the globe loses its relief,
  // not its surface.
  const online = listWhen({ online: true, pack: false });
  const offline = listWhen({ online: false, pack: false });
  assert.equal(terrainFor(online, 'reearth-terrain')?.id, 'reearth-terrain');
  assert.equal(terrainFor(offline, 'reearth-terrain')?.id, 'ellipsoid');
  assert.equal(terrainFor(online, 'cesium-ion-world-terrain')?.id, 'ellipsoid', 'no token, no ion terrain');
  assert.equal(terrainFor(online, 'not-in-the-catalog')?.id, 'ellipsoid');
  assert.equal(terrainFor(null, 'reearth-terrain'), undefined, 'nothing before the list arrives');
});

test('shell map providers: 2D with no basemap it can show says why, and what would work', () => {
  // Online, Natural Earth II configured (3D only) in 2D draws Esri instead: nothing to say.
  assert.equal(missingBasemapReason(list(), 'natural-earth', '2D'), undefined, 'Esri stands in');
  assert.equal(missingBasemapReason(list(), 'none', '2D'), undefined, 'no basemap on purpose says nothing');

  assert.equal(missingBasemapReason(list(), 'natural-earth', '3D'), undefined, 'the globe has its basemap');
  assert.equal(missingBasemapReason(list(), 'esri-world-imagery', '2D'), undefined, 'Esri serves both');
  assert.equal(missingBasemapReason(null, 'natural-earth', '2D'), undefined, 'nothing is said before the list');

  // Offline with nothing cached, nothing at all is available for 2D.
  const offline = resolveMapProviders({ online: false, offlineBasemapAvailable: false });
  const offlineList = { ...list(), basemaps: offline.filter((e) => e.kind === 'basemap') };
  assert.deepEqual(missingBasemapReason(offlineList, 'esri-world-imagery', '2D')?.alternatives, []);
});

test('source basemaps: a map a source publishes is chosen alone, never stacked over another map', () => {
  const topo = {
    kind: 'wms' as const,
    id: 'usgs-topo-wms:0',
    providerId: 'usgs-topo-wms',
    name: 'USGSTopo',
    attribution: 'USGS',
    url: 'https://basemap.nationalmap.gov/arcgis/services/USGSTopo/MapServer/WMSServer',
    layers: '0',
    role: 'basemap' as const,
  };
  const radar = { ...topo, id: 'eccc-radar:radar', providerId: 'eccc-radar', name: 'Radar', role: 'overlay' as const };
  const overlays = [topo, radar];
  // Not chosen: the source map is not drawn at all; the radar still lies over the basemap.
  assert.deepEqual(
    overlaysToDraw(overlays, 'esri-world-imagery').map((o) => o.id),
    ['eccc-radar:radar'],
  );
  // Chosen: it alone is the map, beneath the radar.
  assert.equal(sourceBasemapId(topo), 'source:usgs-topo-wms:0');
  assert.equal(sourceBasemapFor(overlays, 'source:usgs-topo-wms:0')?.id, 'usgs-topo-wms:0');
  assert.deepEqual(
    overlaysToDraw(overlays, 'source:usgs-topo-wms:0').map((o) => o.id),
    ['usgs-topo-wms:0', 'eccc-radar:radar'],
  );
  // Offered in the picker, after the catalog; a chosen map whose source is off says so.
  const choices = basemapChoices(list(), 'esri-world-imagery', overlays);
  assert.ok(choices.some((c) => c.id === 'source:usgs-topo-wms:0' && c.name === 'USGSTopo (source)'));
  assert.ok(!choices.some((c) => c.id === 'source:eccc-radar:radar'), 'an overlay is not a basemap');
  const off = basemapChoices(list(), 'source:usgs-topo-wms:0', []);
  assert.match(off[0]?.name ?? '', /its source is off/);
  assert.equal(missingBasemapReason(list(), 'source:usgs-topo-wms:0', '2D', overlays), undefined);
});
