import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawnBounds,
  isWebMercatorMatrixSet,
  matrixTemplate,
  overlayHost,
  overlaySeries,
  overlayTileTemplate,
  rasterOverlaySchema,
  wmtsNeedsTileUrls,
  wmtsTileUrl,
  type RasterOverlay,
} from './overlay.js';

const base = { id: 'p:layer', providerId: 'p', name: 'Layer', attribution: 'Someone' };

test('overlay schema: https only, no credentials, placeholders required for xyz, a GetMap endpoint without a query', () => {
  const ok = rasterOverlaySchema.parse({ ...base, kind: 'xyz', url: 'https://t.example/{z}/{x}/{y}.png' });
  assert.ok(ok.ok);
  for (const [doc, why] of [
    [{ ...base, kind: 'xyz', url: 'http://t.example/{z}/{x}/{y}.png' }, 'must be https'],
    [{ ...base, kind: 'xyz', url: 'https://u:p@t.example/{z}/{x}/{y}.png' }, 'credentials'],
    [{ ...base, kind: 'xyz', url: 'https://t.example/tile.png' }, 'needs {z}'],
    [{ ...base, kind: 'xyz', url: 'https://{s}.t.example/{z}/{x}/{y}.png' }, 'needs subdomains'],
    [{ ...base, kind: 'wms', url: 'https://w.example/wms?x=1', layers: 'a' }, 'without query'],
    [{ ...base, kind: 'wms', url: 'https://w.example/wms', layers: '' }, 'at least 1'],
    [{ ...base, kind: 'xyz', url: 'https://t.example/{z}/{x}/{y}.png', minZoom: 9, maxZoom: 3 }, 'minZoom'],
    [{ ...base, kind: 'xyz', url: 'https://t.example/{z}/{x}/{y}.png', opacity: 2 }, '<= 1'],
    [{ ...base, id: 'Bad Id', kind: 'xyz', url: 'https://t.example/{z}/{x}/{y}.png' }, 'match'],
  ] as const) {
    const r = rasterOverlaySchema.parse(doc);
    assert.ok(!r.ok, JSON.stringify(doc));
    assert.match(
      r.issues.map((i) => i.message).join('; '),
      new RegExp(why),
      `${JSON.stringify(doc)} → ${r.issues.map((i) => i.message).join('; ')}`,
    );
  }
  assert.equal(
    overlayHost({ ...base, kind: 'xyz', url: 'https://{s}.Tiles.Example/{z}/{x}/{y}.png', subdomains: ['a'] }),
    'x.tiles.example',
  );
});

test('overlay tile templates: xyz as given, wms as a GetMap with {bbox-epsg-3857}, wmts by zoom or a labelled prefix', () => {
  assert.equal(
    overlayTileTemplate({ ...base, kind: 'xyz', url: 'https://t.example/{z}/{x}/{-y}.png' }),
    'https://t.example/{z}/{x}/{-y}.png',
  );
  const wms = overlayTileTemplate({
    ...base,
    kind: 'wms',
    url: 'https://w.example/wms',
    layers: 'roads,rivers',
    styles: 'default',
    version: '1.1.1',
    parameters: { TIME: '2026-09-23' },
    tileSize: 512,
  })!;
  assert.ok(
    wms.startsWith(
      'https://w.example/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=roads%2Crivers&STYLES=default',
    ),
  );
  assert.match(wms, /SRS=EPSG%3A3857/);
  assert.match(wms, /WIDTH=512&HEIGHT=512/);
  assert.match(wms, /TIME=2026-09-23/);
  assert.ok(wms.endsWith('&BBOX={bbox-epsg-3857}'), wms);
  const wms13 = overlayTileTemplate({ ...base, kind: 'wms', url: 'https://w.example/wms', layers: 'a' })!;
  assert.match(wms13, /CRS=EPSG%3A3857/);
  assert.match(wms13, /TRANSPARENT=TRUE/);

  const rest = overlayTileTemplate({
    ...base,
    kind: 'wmts',
    url: 'https://m.example/wmts/1.0.0/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
    layer: 'topo',
    style: 'default',
    format: 'image/png',
    tileMatrixSet: 'GoogleMapsCompatible',
  });
  assert.equal(rest, 'https://m.example/wmts/1.0.0/default/GoogleMapsCompatible/{z}/{y}/{x}.png');
  const labelled = overlayTileTemplate({
    ...base,
    kind: 'wmts',
    url: 'https://m.example/wmts',
    layer: 'topo',
    style: 'default',
    format: 'image/png',
    tileMatrixSet: 'EPSG:3857',
    tileMatrixLabels: ['EPSG:3857:0', 'EPSG:3857:1', 'EPSG:3857:2'],
  })!;
  assert.ok(
    labelled.startsWith('https://m.example/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=topo&STYLE=default'),
  );
  assert.ok(labelled.endsWith('&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}'), labelled);
  assert.equal(
    overlayTileTemplate({
      ...base,
      kind: 'wmts',
      url: 'https://m.example/wmts',
      layer: 'l',
      style: 's',
      format: 'image/png',
      tileMatrixSet: 'EPSG:4326',
    }),
    undefined,
    'a geographic matrix set is not addressable by web mercator zoom',
  );
  assert.equal(matrixTemplate(['a0', 'b1']), undefined);
  assert.equal(matrixTemplate(['0', '1', '2']), '{z}');
  assert.equal(matrixTemplate(['EPSG:3857:0', 'EPSG:3857:1']), 'EPSG:3857:{z}');
  assert.equal(matrixTemplate(['00', '01', '02']), undefined, 'a padded label is not {z}: reported, not guessed');
  assert.equal(matrixTemplate(undefined), '{z}');
  // A set that is Web Mercator by its capabilities, not its name, is drawn when the provider says so.
  const named = {
    ...base,
    kind: 'wmts' as const,
    url: 'https://m.example/wmts/{TileMatrix}/{TileRow}/{TileCol}.png',
    layer: 'l',
    style: 's',
    format: 'image/png',
    tileMatrixSet: 'default028mm',
  };
  assert.equal(overlayTileTemplate(named), undefined);
  assert.equal(overlayTileTemplate({ ...named, webMercator: true }), 'https://m.example/wmts/{z}/{y}/{x}.png');
  assert.equal(overlayTileTemplate({ ...named, tileMatrixSet: 'EPSG:3857', webMercator: false }), undefined);
  assert.ok(
    isWebMercatorMatrixSet('WebMercatorQuad') &&
      isWebMercatorMatrixSet('EPSG:900913') &&
      !isWebMercatorMatrixSet('EPSG:4326'),
  );
});

test('wmtsTileUrl: a zero-padded Web Mercator set is addressed tile by tile, with the label written whole', () => {
  const o = {
    ...base,
    kind: 'wmts' as const,
    url: 'https://m.example/wmts',
    layer: 'l',
    style: 's',
    format: 'image/png',
    tileMatrixSet: 'WEBMERCATOR',
    tileMatrixLabels: ['00', '01', '02'],
  };
  assert.equal(overlayTileTemplate(o), undefined, 'no {z} template');
  assert.ok(wmtsNeedsTileUrls(o));
  assert.equal(
    wmtsTileUrl(o, 2, 3, 1),
    'https://m.example/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=l&STYLE=s&FORMAT=image%2Fpng&TILEMATRIXSET=WEBMERCATOR&TILEMATRIX=02&TILEROW=1&TILECOL=3',
  );
  assert.equal(wmtsTileUrl(o, 3, 0, 0), undefined, 'no matrix at that zoom');
  assert.equal(wmtsNeedsTileUrls({ ...o, tileMatrixSet: 'EPSG:4326' }), false, 'geographic stays unsupported');
  assert.equal(wmtsNeedsTileUrls({ ...o, tileMatrixLabels: ['0', '1'] }), false, 'a {z} template does');
});

test('overlaySeries: frames of one layer are one series, whether the time is a WMS TIME or in a WMTS tile path', () => {
  const gibs = (frame: string) => ({
    ...base,
    id: `gibs:ir:${frame.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    kind: 'wmts' as const,
    url: `https://gibs.example/wmts/ir/default/${frame}/GoogleMapsCompatible_Level6/{TileMatrix}/{TileRow}/{TileCol}.png`,
    layer: 'ir',
    style: 'default',
    format: 'image/png',
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    frame,
  });
  const a = gibs('2026-09-28T15:40:00Z');
  const b = gibs('2026-09-28T15:50:00Z');
  assert.equal(overlaySeries(a), overlaySeries(b));
  // Percent-encoded, as a template filled with encodeURIComponent writes it.
  const encoded = { ...b, url: b.url.replace('2026-09-28T15:50:00Z', encodeURIComponent('2026-09-28T15:50:00Z')) };
  assert.equal(overlaySeries(encoded), overlaySeries(a));
  // Another layer, or the same layer in another style, is not the same series.
  assert.notEqual(overlaySeries({ ...a, layer: 'vis', url: a.url.replace('/ir/', '/vis/') }), overlaySeries(a));
  assert.notEqual(overlaySeries({ ...b, opacity: 0.5 }), overlaySeries(a));
  const wms = (time: string) => ({
    ...base,
    id: `radar:${time}`,
    kind: 'wms' as const,
    url: 'https://w.example/wms',
    layers: 'radar',
    parameters: { TIME: time, STYLE_X: '1' },
    frame: time,
  });
  assert.equal(overlaySeries(wms('2026-09-28T15:40:00Z')), overlaySeries(wms('2026-09-28T15:44:00Z')));
  // The frame is part of the contract: the host's schema check keeps it.
  const parsed = rasterOverlaySchema.parse(a);
  assert.ok(parsed.ok && parsed.value.frame === '2026-09-28T15:40:00Z');
});

test('drawnBounds: a feathered slice is drawn half the feather wider each side, never past 180°', () => {
  assert.deepEqual(drawnBounds({ bounds: { west: -37.5, south: -60, east: 22.5, north: 60 }, featherDeg: 5 }), {
    west: -40,
    south: -60,
    east: 25,
    north: 60,
  });
  const himawari = drawnBounds({ bounds: { west: 93, south: -60, east: 180, north: 60 }, featherDeg: 5 })!;
  assert.deepEqual([himawari.west, himawari.east], [90.5, 180], 'stopped at the antimeridian, not across it');
  const goesWest = drawnBounds({ bounds: { west: -180, south: -60, east: -106, north: 60 }, featherDeg: 5 })!;
  assert.deepEqual([goesWest.west, goesWest.east], [-180, -103.5]);
  assert.deepEqual(drawnBounds({ bounds: { west: 0, south: 0, east: 1, north: 1 } }), {
    west: 0,
    south: 0,
    east: 1,
    north: 1,
  });
  assert.equal(drawnBounds({}), undefined);
});

test('fallbackUrl: on the same host only, and no part of the series', () => {
  const o = {
    kind: 'wmts',
    id: 'gibs:ir:t1',
    providerId: 'gibs',
    name: 'Infrared',
    attribution: 'test',
    url: 'https://gibs.example.invalid/ir/2026-09-29T10:30:00Z/{TileMatrix}/{TileRow}/{TileCol}.png',
    layer: 'ir',
    style: 'default',
    format: 'image/png',
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    frame: '2026-09-29T10:30:00Z',
    fallbackUrl: 'https://gibs.example.invalid/ir/2026-09-29T10:20:00Z/{TileMatrix}/{TileRow}/{TileCol}.png',
  } as RasterOverlay;
  assert.ok(rasterOverlaySchema.parse(o).ok);
  const elsewhere = rasterOverlaySchema.parse({ ...o, fallbackUrl: 'https://other.example.invalid/{TileMatrix}.png' });
  assert.ok(!elsewhere.ok);
  const next = {
    ...o,
    id: 'gibs:ir:t2',
    frame: '2026-09-29T10:40:00Z',
    url: o.url.replace('10:30', '10:40'),
    fallbackUrl: o.url,
  } as RasterOverlay;
  assert.equal(overlaySeries(next), overlaySeries(o), 'the next frame is the same layer advancing');
});
