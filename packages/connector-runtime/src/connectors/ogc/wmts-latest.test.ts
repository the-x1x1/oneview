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

test('wmts latest (GIBS GOES-East, recorded): the time domain is newer than the capabilities, and its frame is drawn', async () => {
  const { overlay, provider, requests } = await overlayOf(byUrl(DOMAINS));
  assert.equal(overlay.frame, '2026-09-28T15:50:00Z');
  assert.equal(
    overlay.url,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:50:00Z/GoogleMapsCompatible_Level6/{TileMatrix}/{TileRow}/{TileCol}.png',
  );
  assert.equal(overlay.id, 'gibs-goes-east-infrared:goes-east_abi_band13_clean_infrared:2026-09-28t15-50-00z');
  assert.equal(overlay.tileMatrixSet, 'GoogleMapsCompatible_Level6');
  assert.equal(overlay.maxZoom, 6);
  assert.equal(overlay.opacity, 0.55, "the definition's opacity until the operator sets one");
  assert.deepEqual(overlay.bounds, { west: -106, south: -81.3, east: 0, north: 81.3 });
  // The capabilities are asked for one layer (GIBS filters on LAYER), the domain for two days back.
  assert.deepEqual(requests, [
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?LAYER=GOES-East_ABI_Band13_Clean_Infrared&SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/GOES-East_ABI_Band13_Clean_Infrared/default/GoogleMapsCompatible_Level6/all/2026-09-26--2026-09-29.xml',
  ]);
  assert.match(
    (await provider.health()).message ?? '',
    /time domain read: newer frame 2026-09-28T15:50:00Z than the capabilities' 2026-09-19T00:20:00Z/,
  );
  // The 2D map's template keeps the colons of the time as GIBS documents its paths.
  assert.equal(
    overlayTileTemplate(overlay),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-09-28T15:50:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
  );
});

test('wmts latest: the next frame is a new descriptor of the same series; a domain that cannot be read falls back', async () => {
  const first = await overlayOf(byUrl(DOMAINS));
  const later = DOMAINS.replace('2026-09-28T15:50:00Z/PT10M', '2026-09-28T16:00:00Z/PT10M');
  const second = await overlayOf(byUrl(later));
  assert.equal(second.overlay.frame, '2026-09-28T16:00:00Z');
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
    '2026-09-28T10:40:00Z',
    'an interval that runs past the clock is passed over whole',
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
