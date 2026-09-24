import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebMercatorMatrixSet,
  matrixTemplate,
  overlayHost,
  overlayTileTemplate,
  rasterOverlaySchema,
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
  assert.equal(matrixTemplate(undefined), '{z}');
  assert.ok(
    isWebMercatorMatrixSet('WebMercatorQuad') &&
      isWebMercatorMatrixSet('EPSG:900913') &&
      !isWebMercatorMatrixSet('EPSG:4326'),
  );
});
