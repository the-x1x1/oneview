import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import { overlaySeries, overlayTileTemplate, type JsonValue, type WmtsOverlay } from '@worldview/world-model';
import { defaultConnectorRegistry } from '../../registry.js';
import { newestInstant, parseOpacity } from './common.js';
import { readTimeDomain, timeDomainTemplate } from './wmts.js';
import { parseWmtsCapabilities } from './capabilities.js';

/**
 * `time: "latest"` on the WMTS connector (2026-09-28, global weather layers), against NASA
 * GIBS: the GOES-East capabilities as recorded that day named a default nine days old while
 * the layer's time domain (DescribeDomains, also recorded) ran to 15:50Z, so the domain is
 * read after the capabilities and a newer frame there wins. Fixtures and their provenance:
 * fixtures/connectors/hazards/README.md.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const CAPS = read('fixtures/connectors/hazards/gibs-goes-east-ir-wmts-capabilities.xml');
const DOMAINS = read('fixtures/connectors/hazards/gibs-goes-east-ir-domains.xml');
const DEFINITION = JSON.parse(read('connectors/enabled/gibs-goes-east-infrared.json')) as Record<string, unknown>;
const NOW = Date.parse('2026-09-28T16:15:00.000Z');

async function overlayOf(
  responder: testing.FixtureResponder,
  opts: { settings?: Record<string, JsonValue>; doc?: Record<string, unknown>; now?: number } = {},
) {
  const v = defaultConnectorRegistry.validate(opts.doc ?? DEFINITION);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  const provider = defaultConnectorRegistry.createProvider(v.definition!);
  const requests: string[] = [];
  const ctx = testing.createFixtureContext({
    providerId: v.definition!.id,
    clock: new testing.VirtualClock(opts.now ?? NOW),
    responder: (req: ProviderHttpRequest) => {
      requests.push(req.url);
      return responder(req);
    },
    settings: opts.settings ?? {},
  });
  await provider.initialize(ctx);
  await provider.start();
  const [overlay] = await provider.overlays!();
  assert.ok(overlay && overlay.kind === 'wmts');
  return { overlay: overlay as WmtsOverlay, provider, requests };
}

const byUrl = (domains: string) => (req: ProviderHttpRequest) => ({
  status: 200,
  body: /REQUEST=GetCapabilities/.test(req.url) ? CAPS : domains,
});

test('wmts latest (GIBS GOES-East, recorded): the time domain is newer than the capabilities, and the frame before its newest is drawn', async () => {
  const { overlay, provider, requests } = await overlayOf(byUrl(DOMAINS));
  assert.equal(
    overlay.frame,
    '2026-09-28T15:40:00Z',
    'one period behind the newest listed, which GIBS may still be rendering',
  );
  assert.equal(
    overlay.url,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:40:00Z/GoogleMapsCompatible_Level6/{TileMatrix}/{TileRow}/{TileCol}.png',
  );
  assert.equal(overlay.id, 'gibs-goes-east-infrared:goes-east_abi_band13_clean_infrared:2026-09-28t15-40-00z');
  assert.equal(overlay.tileMatrixSet, 'GoogleMapsCompatible_Level6');
  assert.equal(overlay.maxZoom, 6);
  assert.equal(overlay.opacity, 0.85, "the definition's opacity until the operator sets one");
  assert.deepEqual(overlay.fadeBelow, { from: 135, to: 195, monochrome: true }, 'drawn as its clouds only, in grey');
  assert.equal(overlay.featherDeg, 5, 'cross-faded with its neighbours across 5°');
  assert.deepEqual(overlay.bounds, { west: -106, south: -60, east: -37.5, north: 60 });
  // The capabilities are asked for one layer (GIBS filters on LAYER), the domain for two days back.
  assert.deepEqual(requests, [
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?LAYER=GOES-East_ABI_Band13_Clean_Infrared&SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/GOES-East_ABI_Band13_Clean_Infrared/default/GoogleMapsCompatible_Level6/all/2026-09-26--2026-09-29.xml',
    // Two tiles of the new frame, at zoom 1 and 3 in the middle of the slice: is it there yet?
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:40:00Z/GoogleMapsCompatible_Level6/1/1/0.png',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:40:00Z/GoogleMapsCompatible_Level6/3/4/2.png',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:40:00Z/GoogleMapsCompatible_Level6/5/16/9.png',
  ]);
  assert.match(
    (await provider.health()).message ?? '',
    /time domain read: newer frame 2026-09-28T15:40:00Z than the capabilities' 2026-09-19T00:20:00Z/,
  );
  // The 2D map's template keeps the colons of the time as GIBS documents its paths.
  assert.equal(
    overlayTileTemplate(overlay),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:40:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
  );
});

test('wmts latest: the next frame is a new descriptor of the same series; a domain that cannot be read falls back', async () => {
  const first = await overlayOf(byUrl(DOMAINS));
  const later = DOMAINS.replace('2026-09-28T15:50:00Z/PT10M', '2026-09-28T16:00:00Z/PT10M');
  const second = await overlayOf(byUrl(later));
  assert.equal(second.overlay.frame, '2026-09-28T15:50:00Z');
  assert.notEqual(second.overlay.id, first.overlay.id);
  assert.equal(overlaySeries(second.overlay), overlaySeries(first.overlay), 'the renderers hand it over');
  // Every request answered with the capabilities: the domain is not a Domains answer.
  const fallback = await overlayOf(() => ({ status: 200, body: CAPS }));
  assert.equal(fallback.overlay.frame, '2026-09-19T00:20:00Z', "the capabilities' newest frame");
  assert.match(
    (await fallback.provider.health()).message ?? '',
    /time domain not read \(the answer is a Capabilities, not Domains\)/,
  );
  // A server error on the domain is the same.
  const failed = await overlayOf((req) =>
    /REQUEST=GetCapabilities/.test(req.url) ? { status: 200, body: CAPS } : { status: 500, body: 'no' },
  );
  assert.equal(failed.overlay.frame, '2026-09-19T00:20:00Z');
  // A frame the domain puts beyond the clock (a wrong clock, a forecast) is not taken.
  const future = await overlayOf(byUrl(DOMAINS), { now: Date.parse('2026-09-28T15:00:00.000Z') });
  assert.equal(
    future.overlay.frame,
    '2026-09-28T10:30:00Z',
    'an interval that runs past the clock is passed over whole (and the frame before the newest drawn)',
  );
});

test("wmts time: the operator's instant is drawn as asked, with no domain read and the plain id", async () => {
  const { overlay, requests } = await overlayOf(byUrl(DOMAINS), {
    settings: { time: '2026-09-18T12:00:00Z', opacity: 1 },
  });
  assert.equal(overlay.frame, undefined);
  assert.equal(overlay.id, 'gibs-goes-east-infrared:goes-east_abi_band13_clean_infrared');
  assert.match(overlay.url, /\/default\/2026-09-18T12:00:00Z\/GoogleMapsCompatible_Level6\//);
  assert.equal(overlay.opacity, 1, "the operator's opacity wins");
  assert.equal(requests.length, 1);
});

test('wmts validation: latest is a time; a bad time or opacity is refused', () => {
  const endpoint = DEFINITION['endpoint'] as { query: Record<string, unknown> };
  const withQuery = (q: Record<string, unknown>) => ({
    ...DEFINITION,
    endpoint: { ...endpoint, query: { ...endpoint.query, ...q } },
  });
  assert.ok(defaultConnectorRegistry.validate(withQuery({ time: 'latest' })).ok);
  const bad = defaultConnectorRegistry.validate(withQuery({ time: 'newest', opacity: 1.5 }));
  assert.ok(!bad.ok);
  assert.match(bad.errors.join('; '), /time "newest" is not ISO 8601, "current" or "latest"/);
  assert.match(bad.errors.join('; '), /opacity "1.5" is not a number from 0 to 1/);
  assert.equal(parseOpacity(undefined), undefined);
  assert.equal(parseOpacity('0'), 0);
  assert.equal(typeof parseOpacity(''), 'string');
});

test('time domain helpers: the template with a start and an end and no box; the domain read from a Domains answer', () => {
  const caps = parseWmtsCapabilities(CAPS);
  assert.ok('layers' in caps);
  assert.equal(
    timeDomainTemplate(caps.layers[0]!),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/GOES-East_ABI_Band13_Clean_Infrared/default/{TileMatrixSet}/all/{TimeStart}--{TimeEnd}.xml',
  );
  assert.deepEqual(readTimeDomain(DOMAINS), {
    values: '2026-09-27/2026-09-28T10:40:00Z/PT10M,2026-09-28T11:00:00Z/2026-09-28T15:50:00Z/PT10M',
  });
  assert.deepEqual(readTimeDomain('<Domains/>'), { problem: 'the answer has no time domain' });
  assert.ok('problem' in readTimeDomain('not xml'));
  // The newest instant: interval ends and single instants alike, the default given no precedence.
  assert.equal(
    newestInstant(['2026-09-19T00:20:00Z', '2026-06-10T20:10:00Z/2026-09-22T18:20:00Z/PT10M', 'current']),
    '2026-09-22T18:20:00Z',
  );
  assert.equal(newestInstant(['current', undefined, '2026-09-23T23:30:00Z/current/PT6M']), undefined);
});

test("newestInstant: a daily layer's dates count as frames, written back as dates; instants still compare", () => {
  assert.equal(newestInstant(['2026-08-18', '2022-01-14/2026-08-18/P1D', '2026-09-25/2026-09-28/P1D']), '2026-09-28');
  assert.equal(newestInstant(['2026-09-27', '2026-09-28T10:30:00Z']), '2026-09-28T10:30:00Z');
  assert.equal(newestInstant(['2026-9-28', 'yesterday']), undefined, 'not a calendar date');
});

/**
 * `timeFrom` and `maxZoom` (2026-09-29, EUMETView infrared): GeoServer's tile cache takes a
 * `TIME` parameter it does not advertise as a WMTS dimension, so the frame is read from the
 * layer's WMS capabilities; its Web Mercator set runs to zoom 30 and is cut at `maxZoom`.
 */
const EV_WMTS = read('fixtures/connectors/hazards/eumetview-reconstructed-no-time-wmts-capabilities.xml');
const EV_WMS = read('fixtures/connectors/hazards/eumetview-msg-fes-ir108-wms130-capabilities.xml');
const EV_SHIPPED = JSON.parse(read('connectors/enabled/eumetsat-meteosat-infrared.json')) as Record<string, unknown>;
const withQuery = (doc: Record<string, unknown>, q: Record<string, unknown>) => {
  const endpoint = doc['endpoint'] as { query: Record<string, unknown> };
  const query = Object.fromEntries(Object.entries({ ...endpoint.query, ...q }).filter(([, v]) => v !== undefined));
  return { ...doc, endpoint: { ...endpoint, query } };
};
/** The shipped definition as it was written for a cache without a time dimension (the 900913 set, zoom 6). */
const EV_DEFINITION = withQuery(EV_SHIPPED, { tileMatrixSet: 'EPSG:900913', maxZoom: 6 });
const evQuery = (q: Record<string, unknown>) => withQuery(EV_DEFINITION, q);
const evByService = (wms: string | (() => { status: number; body: string })) => (req: ProviderHttpRequest) =>
  /SERVICE=WMTS/.test(req.url)
    ? { status: 200, body: EV_WMTS }
    : typeof wms === 'string'
      ? { status: 200, body: wms }
      : wms();

test('wmts timeFrom: a time the WMTS answer does not name is read from the WMS capabilities and sent as TIME', async () => {
  const { overlay, provider } = await overlayOf(evByService(EV_WMS), { doc: EV_DEFINITION });
  assert.equal(overlay.frame, '2026-09-29T03:00:00Z');
  assert.match(overlay.url, /\?format=image\/png&TIME=2026-09-29T03:00:00.000Z$/);
  assert.match(
    (await provider.health()).message ?? '',
    /time latest: 2026-09-29T03:00:00Z, sent as TIME with each tile/,
  );
  // The 2D map's template keeps the parameter.
  assert.match(
    overlayTileTemplate(overlay)!,
    /EPSG:900913:\{z\}\/\{y\}\/\{x\}\?format=image\/png&TIME=2026-09-29T03:00:00.000Z$/,
  );
});

test('wmts timeFrom: an unreadable time document leaves the tiles without a time and says so; a pinned time needs no read', async () => {
  for (const answer of [EV_WMTS, 'not xml', () => ({ status: 500, body: 'no' })]) {
    const { overlay, provider } = await overlayOf(evByService(answer), { doc: EV_DEFINITION });
    assert.equal(overlay.frame, undefined);
    assert.equal(overlay.id, 'eumetsat-meteosat-infrared:ir108');
    assert.doesNotMatch(overlay.url, /TIME=/);
    assert.match((await provider.health()).message ?? '', /time not read from timeFrom/);
  }
  const wrongLayer = EV_WMS.replace('<Name>ir108</Name>', '<Name>vis006</Name>');
  const missing = await overlayOf(evByService(wrongLayer), { doc: EV_DEFINITION });
  assert.match((await missing.provider.health()).message ?? '', /no layer "ir108" in it/);
  const pinned = await overlayOf(evByService(EV_WMS), {
    doc: EV_DEFINITION,
    settings: { time: '2026-09-28T12:00:00Z' },
  });
  assert.equal(pinned.requests.length, 1);
  assert.equal(pinned.overlay.frame, undefined);
  assert.match(pinned.overlay.url, /&TIME=2026-09-28T12:00:00.000Z$/);
});

test('wmts maxZoom: the set is cut at that zoom; without it the tile cache set runs to 30', async () => {
  const capped = await overlayOf(evByService(EV_WMS), { doc: EV_DEFINITION });
  assert.equal(capped.overlay.maxZoom, 6);
  assert.equal(capped.overlay.tileMatrixLabels?.length, 7);
  const full = await overlayOf(evByService(EV_WMS), { doc: evQuery({ maxZoom: undefined }) });
  assert.equal(full.overlay.maxZoom, 30);
});

test('wmts validation: timeFrom must be https on the endpoint host; maxZoom a whole number from 0 to 30', () => {
  assert.ok(defaultConnectorRegistry.validate(EV_DEFINITION).ok);
  const elsewhere = defaultConnectorRegistry.validate(
    evQuery({ timeFrom: 'https://example.org/ows?SERVICE=WMS&REQUEST=GetCapabilities', maxZoom: 31 }),
  );
  assert.ok(!elsewhere.ok);
  assert.match(elsewhere.errors.join('; '), /timeFrom is on example\.org, which the definition does not name/);
  assert.match(elsewhere.errors.join('; '), /maxZoom "31" is not a whole number from 0 to 30/);
  const plain = defaultConnectorRegistry.validate(
    evQuery({ timeFrom: 'http://view.eumetsat.int/geoserver/msg_fes/ir108/ows', maxZoom: 2.5 }),
  );
  assert.match(plain.errors.join('; '), /timeFrom is not https/);
  assert.match(plain.errors.join('; '), /maxZoom "2.5"/);
});

/**
 * EUMETView as recorded on 2026-09-29: the tile cache now advertises its `time` dimension, but
 * its templates have no `{Time}`, its `EPSG:900913` set answers every tile with an error, and
 * the `TIME` it takes must carry milliseconds. The frame rides as `TIME` in that spelling, and
 * the 512-pixel Web Mercator set is drawn with 512-pixel tiles.
 */
const EV_RECORDED = read('fixtures/connectors/hazards/eumetview-msg-fes-ir108-wmts-capabilities.xml');

test('wmts: a time dimension the template has no place for rides as TIME, spelled with milliseconds', async () => {
  const { overlay, provider, requests } = await overlayOf(() => ({ status: 200, body: EV_RECORDED }), {
    doc: EV_SHIPPED,
  });
  assert.equal(requests.length, 1, 'the WMTS answer names the time: no second read');
  assert.equal(overlay.frame, '2026-09-29T04:45:00Z');
  assert.equal(overlay.id, 'eumetsat-meteosat-infrared:ir108:2026-09-29t04-45-00z');
  assert.equal(
    overlay.url,
    'https://view.eumetsat.int/geoserver/msg_fes/ir108/gwc/service/wmts/rest/ir108/raster/EPSG%3A3857%20-%20512/{TileMatrix}/{TileRow}/{TileCol}?format=image/png&TIME=2026-09-29T04:45:00.000Z',
  );
  assert.equal(overlay.tileSize, 512);
  assert.deepEqual([overlay.minZoom, overlay.maxZoom], [0, 5]);
  assert.equal(overlay.tileMatrixLabels?.[2], 'EPSG:3857 - 512:2');
  // The 2D map's tile: the space encoded, the colons kept (as EUMETView answered on 2026-09-29).
  assert.equal(
    overlayTileTemplate(overlay),
    'https://view.eumetsat.int/geoserver/msg_fes/ir108/gwc/service/wmts/rest/ir108/raster/EPSG%3A3857%20-%20512/EPSG:3857%20-%20512:{z}/{y}/{x}?format=image/png&TIME=2026-09-29T04:45:00.000Z',
  );
  assert.match((await provider.health()).message ?? '', /time latest: 2026-09-29T04:45:00Z/);
});

test('wmts: with no set named, a 256-pixel set is chosen before a 512-pixel one', async () => {
  const { overlay } = await overlayOf(() => ({ status: 200, body: EV_RECORDED }), {
    doc: withQuery(EV_SHIPPED, { tileMatrixSet: undefined }),
  });
  assert.equal(overlay.tileMatrixSet, 'EPSG:900913');
  assert.equal(overlay.tileSize, 256);
});

test('tileCacheTime: full instants get milliseconds; anything else goes as it is', async () => {
  const { tileCacheTime } = await import('./wmts.js');
  assert.equal(tileCacheTime('2026-09-29T04:45:00Z'), '2026-09-29T04:45:00.000Z');
  assert.equal(tileCacheTime('2026-09-29T04:45Z'), '2026-09-29T04:45:00.000Z');
  assert.equal(tileCacheTime('2026-09-29T06:45:00+02:00'), '2026-09-29T04:45:00.000Z');
  assert.equal(tileCacheTime('2026-09-29'), '2026-09-29');
  assert.equal(tileCacheTime('current'), 'current');
});

test('wmts hideAboveZoom: carried to the overlay; not a zoom is refused', async () => {
  const { overlay } = await overlayOf(byUrl(DOMAINS), { doc: withQuery(DEFINITION, { hideAboveZoom: 9 }) });
  assert.equal(overlay.hideAboveZoom, 9);
  const bad = defaultConnectorRegistry.validate(withQuery(DEFINITION, { hideAboveZoom: 'close' }));
  assert.ok(!bad.ok);
  assert.match(bad.errors.join('; '), /hideAboveZoom "close" is not a zoom from 0 to 30/);
  const imerg = JSON.parse(read('connectors/enabled/gibs-imerg-precipitation.json')) as {
    endpoint: { query: Record<string, unknown> };
  };
  assert.equal(imerg.endpoint.query['hideAboveZoom'], 9, 'IMERG is not a coloured wash over a city');
});

test('wmts latest: a frame GIBS lists before its tiles exist is waited for, the frame drawn before kept', async () => {
  let tileStatus = 404;
  const responder = (req: ProviderHttpRequest) =>
    /\.png$/.test(req.url)
      ? { status: tileStatus, body: tileStatus === 404 ? 'Not Found' : 'png' }
      : { status: 200, body: /REQUEST=GetCapabilities/.test(req.url) ? CAPS : DOMAINS };
  const { overlay, provider } = await overlayOf(responder);
  assert.equal(overlay.frame, '2026-09-28T15:30:00Z', 'not there yet: the frame before it in the domain');
  assert.match(
    (await provider.health()).message ?? '',
    /its tiles are not all there yet, so 2026-09-28T15:30:00Z is shown/,
  );
  tileStatus = 200;
  await provider.query!({ signal: new AbortController().signal, background: true });
  const [next] = await provider.overlays!();
  assert.equal(next?.kind === 'wmts' && next.frame, '2026-09-28T15:40:00Z', 'drawn once its tiles are there');
  // Once drawn it is not checked again, and a later frame not yet whole keeps it.
  const shown = next as WmtsOverlay;
  tileStatus = 404;
  await provider.query!({ signal: new AbortController().signal, background: true });
  const [same] = await provider.overlays!();
  assert.equal(same?.id, shown.id);
});

test('wmts latest: a tile check that cannot be made does not hold the frame back', async () => {
  const responder = (req: ProviderHttpRequest) =>
    /\.png$/.test(req.url)
      ? { status: 503, body: '' }
      : { status: 200, body: /REQUEST=GetCapabilities/.test(req.url) ? CAPS : DOMAINS };
  const { overlay } = await overlayOf(responder);
  assert.equal(overlay.frame, '2026-09-28T15:40:00Z');
});

test('wmts latest: a frame missing only its coarse tiles is waited for too', async () => {
  const responder = (req: ProviderHttpRequest) =>
    /\/1\/\d+\/\d+\.png$/.test(req.url)
      ? { status: 404, body: 'Not Found' }
      : /\.png$/.test(req.url)
        ? { status: 200, body: 'png' }
        : { status: 200, body: /REQUEST=GetCapabilities/.test(req.url) ? CAPS : DOMAINS };
  const { overlay } = await overlayOf(responder);
  assert.equal(overlay.frame, '2026-09-28T15:30:00Z');
});

test('settledFrame: an instant one period back; a date, or an instant with no period, as it is', async () => {
  const { settledFrame } = await import('./wmts.js');
  const values = '2026-09-27/2026-09-28T10:40:00Z/PT10M,2026-09-28T11:00:00Z/2026-09-28T15:50:00Z/PT10M';
  assert.equal(settledFrame(values, '2026-09-28T15:50:00Z'), '2026-09-28T15:40:00Z');
  assert.equal(settledFrame('2026-09-25/2026-09-28/P1D', '2026-09-28'), '2026-09-28');
  assert.equal(settledFrame('2026-09-28T15:50:00Z', '2026-09-28T15:50:00Z'), '2026-09-28T15:50:00Z');
});

test('wmts monochrome and featherDeg: validated, and only with fadeBelow', () => {
  const noFade = defaultConnectorRegistry.validate(withQuery(DEFINITION, { fadeBelow: undefined, featherDeg: 5 }));
  assert.match(noFade.errors.join('; '), /featherDeg needs fadeBelow/);
  const bad = defaultConnectorRegistry.validate(withQuery(DEFINITION, { monochrome: 'grey', featherDeg: 45 }));
  assert.match(bad.errors.join('; '), /monochrome "grey" is not true or false/);
  assert.match(bad.errors.join('; '), /featherDeg "45" is not a number of degrees/);
});

test('previousInstant: one period back within the interval that ends at the frame', async () => {
  const { previousInstant } = await import('./common.js');
  const domain = ['2026-09-27/2026-09-28T10:40:00Z/PT10M', '2026-09-28T11:00:00Z/2026-09-28T15:50:00Z/PT10M'];
  assert.equal(previousInstant(domain, '2026-09-28T15:50:00Z'), '2026-09-28T15:40:00Z');
  assert.equal(previousInstant(['2026-09-25/2026-09-28/P1D'], '2026-09-28'), '2026-09-27', 'a daily layer, as a date');
  assert.equal(previousInstant(['2026-09-28T15:50:00Z/2026-09-28T15:50:00Z/PT10M'], '2026-09-28T15:50:00Z'), undefined);
  assert.equal(previousInstant(domain, '2026-09-28T15:40:00Z'), '2026-09-28T15:30:00Z', 'inside an interval too');
  assert.equal(previousInstant(domain, '2026-09-28T10:50:00Z'), undefined, 'in no interval');
  assert.equal(previousInstant(domain, '2026-09-28T15:45:00Z'), undefined, 'not on the period');
});

test('finishedDay: today is not drawn until it is over; yesterday is, and instants pass through', async () => {
  const { finishedDay } = await import('./wmts.js');
  const now = Date.parse('2026-09-29T08:00:00Z');
  assert.equal(finishedDay('2026-09-29', now), '2026-09-28');
  assert.equal(finishedDay('2026-09-28', now), '2026-09-28');
  assert.equal(finishedDay('2026-09-29T07:50:00Z', now), '2026-09-29T07:50:00Z');
});
