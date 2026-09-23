import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import {
  PublicCamerasProvider,
  PUBLIC_CAMERA_FRAME_HOSTS,
  PUBLIC_CAMERA_PACKS,
  PUBLIC_CAMERAS_MANIFEST,
  PUBLIC_CAMERAS_UNVERIFIED_MANIFEST,
  UNVERIFIED_CAMERA_PACKS,
  CALTRANS_DISTRICTS,
  QLD_PUBLIC_API_KEY,
  austinPack,
  caltransUrl,
  createUnverifiedProvider,
  iowaPack,
  iowaUrl,
  normalizeCaltrans,
  normalizeHongKong,
  normalizeIceland,
  normalizeQueensland,
  nycPack,
  parseFlatXmlRecords,
} from '../../src/index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'cctv-public',
);
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const json = (name: string): unknown => JSON.parse(body(name));
const opts = {
  observedAt: '2026-09-21T08:05:00.000Z',
  origin: 'live' as const,
  sourceRef: 'fixture',
  hash: (s: string) => 'b'.repeat(63) + (s.length % 10),
};
const ids = (r: { drafts: Array<{ externalId: string }> }) => r.drafts.map((d) => d.externalId);
const byId = (r: { drafts: Array<{ externalId: string; payload: Record<string, unknown> }> }, id: string) =>
  r.drafts.find((d) => d.externalId === id);

test('flat XML records: fields and the five predefined entities, nothing else', () => {
  const recs = parseFlatXmlRecords(
    '<list><image><key>A1</key><description>Queen&apos;s Rd &amp; Pier &lt;1&gt; &quot;x&quot;</description></image><image><key>B2</key><nested><x>1</x></nested></image></list>',
    'image',
  );
  assert.equal(recs.length, 2);
  assert.equal(recs[0]!['description'], 'Queen\'s Rd & Pier <1> "x"');
  assert.equal(recs[1]!['key'], 'B2');
  assert.equal(recs[1]!['nested'], undefined, 'nesting is not read');
});

test('hong kong: frames rebuilt from the key on the Transport Department host; bad keys, places and repeats refused', () => {
  const r = normalizeHongKong(body('hongkong-cameras.xml'), opts);
  assert.deepEqual(ids(r), ['hongkong:H109F', 'hongkong:K107F', 'hongkong:TC560F']);
  assert.equal(r.total, 6);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['invalid id', 'invalid coordinates', 'duplicate id K107F'],
  );
  const qrc = byId(r, 'hongkong:H109F')!;
  assert.equal(qrc.payload['name'], "Queen's Road Central near Harbour Street", 'the [key] suffix is dropped');
  assert.equal(qrc.payload['region'], 'Central & Western, Hong Kong Island');
  assert.equal(qrc.payload['frameUrl'], 'https://tdcctv.data.one.gov.hk/H109F.JPG');
  assert.equal(qrc.payload['refreshSeconds'], 120);
  assert.equal(
    byId(r, 'hongkong:TC560F')!.payload['frameUrl'],
    'https://tdcctv.data.one.gov.hk/TC560F.JPG',
    'the URL in the file (another host) is ignored',
  );
  assert.equal(normalizeHongKong('<html>busy</html>', opts).malformed, true);
  assert.equal(normalizeHongKong({ not: 'text' }, opts).malformed, true);
  const empty = normalizeHongKong(body('hongkong-empty.xml'), opts);
  assert.equal(empty.malformed, undefined);
  assert.equal(empty.total, 0);
});

test('iceland: one camera per image, id from the file name, http upgraded, only the webcam directory', () => {
  const r = normalizeIceland(json('iceland-webcams.json'), opts);
  assert.deepEqual(ids(r), ['iceland:hellisheidi_1', 'iceland:hellisheidi_2', 'iceland:oxnadalsheidi_1']);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['frame url not on the pinned host', 'invalid coordinates', 'duplicate id hellisheidi_1'],
  );
  const east = byId(r, 'iceland:hellisheidi_1')!;
  assert.equal(east.payload['frameUrl'], 'https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg');
  assert.equal(east.payload['name'], 'Hellisheiði, horft til austurs');
  assert.equal(east.payload['region'], 'Suðurlandsvegur (1)');
  assert.equal(east.payload['headingDegrees'], undefined, 'Icelandic prose is not parsed for a facing');
  assert.equal(byId(r, 'iceland:oxnadalsheidi_1')!.payload['name'], 'Öxnadalsheiði', 'no description: the camera name');
  assert.equal(normalizeIceland({ cameras: [] }, opts).malformed, true);
});

test('queensland: the published anonymous key, CC BY images only, compass words to headings', () => {
  const r = normalizeQueensland(json('qldtraffic-webcams.geojson'), opts);
  assert.deepEqual(ids(r), ['queensland:1', 'queensland:5', 'queensland:90']);
  assert.equal(r.total, 6);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['frame url not on the pinned host', 'invalid coordinates'],
    'the third-party image (77) is skipped silently, not rejected',
  );
  assert.equal(byId(r, 'queensland:1')!.payload['headingDegrees'], 45);
  const range = byId(r, 'queensland:5')!;
  assert.equal(range.payload['headingDegrees'], 90);
  assert.equal(
    range.payload['frameUrl'],
    'https://cameras.qldtraffic.qld.gov.au/Darling_Downs/Toowoomba_range_east.jpg',
  );
  assert.equal(range.payload['region'], 'Toowoomba City, Darling Downs');
  assert.equal(byId(r, 'queensland:90')!.quality.flags?.includes('heading-unknown'), true);
  assert.equal(normalizeQueensland({ type: 'Feature' }, opts).malformed, true);
  assert.match(QLD_PUBLIC_API_KEY, /^[0-9a-f]{32}$/);
});

test('queensland: observations cite the endpoint without the key', async () => {
  const provider = new PublicCamerasProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras',
    responder: (req) =>
      req.url.startsWith('https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=')
        ? { status: 200, body: body('qldtraffic-webcams.geojson') }
        : { status: 200, body: '[]' },
    settings: { packs: Object.fromEntries(PUBLIC_CAMERA_PACKS.map((p) => [p.id, p.id === 'queensland'])) },
  });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 3);
  assert.ok(obs.every((o) => o.provenance.sourceRef === 'https://api.qldtraffic.qld.gov.au/v1/webcams'));
  assert.ok(
    obs.every((o) => !JSON.stringify(o).includes(QLD_PUBLIC_API_KEY)),
    'the key is in no observation',
  );
});

test('hong kong: the XML catalogue reaches the pack as text', async () => {
  const provider = new PublicCamerasProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras',
    responder: () => ({ status: 200, body: body('hongkong-cameras.xml'), headers: { 'content-type': 'text/xml' } }),
    settings: { packs: Object.fromEntries(PUBLIC_CAMERA_PACKS.map((p) => [p.id, p.id === 'hongkong'])) },
  });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 3);
  assert.equal((await provider.health()).status, 'LIVE');
});

test('caltrans: every district, in service only, district-qualified ids, direction and elevation', () => {
  const r = normalizeCaltrans([json('unverified/caltrans-d4.json'), json('unverified/caltrans-d7.json')], opts);
  assert.deepEqual(ids(r), ['caltrans:d4-tv102', 'caltrans:d4-tv105', 'caltrans:d7-tv400']);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['frame url not on the pinned host', 'invalid coordinates'],
  );
  const bay = byId(r, 'caltrans:d4-tv102')!;
  assert.equal(bay.payload['name'], 'I-80 : West of Bay Bridge Toll Plaza (Oakland)');
  assert.equal(bay.payload['headingDegrees'], 270);
  assert.equal(bay.position?.altitudeM, 12, '40 ft');
  assert.equal(byId(r, 'caltrans:d7-tv400')!.payload['headingDegrees'], 180);
  assert.equal(byId(r, 'caltrans:d4-tv105')!.position?.altitudeM, undefined, 'no elevation, none invented');
  assert.equal(normalizeCaltrans({ error: 'x' }, opts).malformed, true);
  assert.equal(normalizeCaltrans([{ data: [] }], opts).malformed, undefined, 'an empty district is not malformed');
});

test('austin, new york, iowa: switched-off cameras skipped, frames pinned to each city’s host', () => {
  const austin = austinPack.normalize(json('unverified/austin-cameras.json'), opts);
  assert.deepEqual(ids(austin), ['austin:912', 'austin:1001']);
  assert.deepEqual(
    austin.rejected.map((x) => x.reason),
    ['frame url not on the pinned host'],
  );
  assert.equal(byId(austin, 'austin:912')!.position?.latitude, 30.2691);
  const nyc = nycPack.normalize(json('unverified/nyc-cameras.json'), opts);
  assert.equal(nyc.drafts.length, 2, 'the offline camera is skipped');
  assert.equal(byId(nyc, 'nyc:8d2b4ac2-3a4c-4f6c-9a3d-1c5e0b1d2e3f')!.payload['region'], 'Brooklyn');
  const iowa = iowaPack.normalize(json('unverified/iowa-cameras.json'), opts);
  assert.deepEqual(ids(iowa), ['iowa:DMTV01', 'iowa:DMTV02', 'iowa:CRTV12'], 'one camera per view');
  assert.equal(byId(iowa, 'iowa:DMTV01')!.payload['region'], 'I-80, Des Moines');
  assert.equal(byId(iowa, 'iowa:DMTV02')!.payload['device'], '1204', 'the device is kept');
  assert.deepEqual(
    iowa.rejected.map((x) => x.reason),
    ['invalid coordinates'],
  );
  // Pages: the rows of every page, and an empty last page is not malformed.
  const paged = iowaPack.normalize([json('unverified/iowa-cameras.json'), { features: [] }], opts);
  assert.equal(paged.drafts.length, 3);
  assert.equal(iowaPack.moreRequests?.length, 2);
  assert.match(iowaUrl(2), /resultOffset=2000&resultRecordCount=1000$/);
  for (const pack of [austinPack, nycPack, iowaPack])
    assert.equal(pack.normalize({ nope: true }, opts).malformed, true, pack.id);
});

test('unverified provider: off by default, manual review, a day of retention, nothing exported', () => {
  const m = PUBLIC_CAMERAS_UNVERIFIED_MANIFEST;
  assert.equal(m.enabledByDefault, false);
  assert.equal(m.commercialReview, 'manual-review-required');
  assert.equal(m.dataPolicy.maxRetentionSeconds, 86400);
  assert.equal(m.dataPolicy.exportAllowed, false);
  assert.equal(m.dataPolicy.offlinePackAllowed, false);
  assert.equal(m.dataPolicy.rawPayloadRetentionAllowed, false);
  assert.equal(m.dataPolicy.commercialUseAllowed, 'unknown');
  assert.equal(createUnverifiedProvider().manifest.id, 'public-cameras-unverified');
  const verified = new Set(PUBLIC_CAMERA_PACKS.map((p) => p.id));
  for (const p of UNVERIFIED_CAMERA_PACKS) assert.equal(verified.has(p.id), false, `${p.id} is in both providers`);
  assert.deepEqual(
    Object.keys(PUBLIC_CAMERA_FRAME_HOSTS).sort(),
    [...PUBLIC_CAMERA_PACKS, ...UNVERIFIED_CAMERA_PACKS].map((p) => p.id).sort(),
    'the gateway allowlist covers both providers',
  );
  // Settings name exactly the packs each provider carries.
  const keys = (mf: typeof m) => (mf.settings ?? []).map((s) => s.key).sort();
  assert.deepEqual(keys(m), UNVERIFIED_CAMERA_PACKS.map((p) => `packs.${p.id}`).sort());
  assert.deepEqual(keys(PUBLIC_CAMERAS_MANIFEST), PUBLIC_CAMERA_PACKS.map((p) => `packs.${p.id}`).sort());
  // Every catalogue host is declared by the provider that fetches it.
  for (const [manifest, packs] of [
    [PUBLIC_CAMERAS_MANIFEST, PUBLIC_CAMERA_PACKS],
    [m, UNVERIFIED_CAMERA_PACKS],
  ] as const)
    for (const p of packs)
      for (const req of [p.request, ...(p.moreRequests ?? [])])
        assert.ok(manifest.allowedHosts.includes(new URL(req.url).hostname), `${p.id}: ${req.url}`);
});

test('unverified provider: Caltrans districts fetched one by one; a failing district is logged and skipped', async () => {
  const provider = createUnverifiedProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras-unverified',
    responder: (req) => {
      if (req.url === caltransUrl(4)) return { status: 200, body: body('unverified/caltrans-d4.json') };
      if (req.url === caltransUrl(7)) return { status: 200, body: body('unverified/caltrans-d7.json') };
      if (req.url === caltransUrl(9)) return { status: 503 };
      if (req.url.includes('cwwp2.dot.ca.gov'))
        return { status: 200, body: body('unverified/caltrans-empty-district.json') };
      return { status: 404 };
    },
    settings: { packs: { austin: false, nyc: false, iowa: false } },
  });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 3);
  assert.deepEqual(
    ctx.http.requests.map((r) => r.url),
    CALTRANS_DISTRICTS.map(caltransUrl),
    'in district order',
  );
  assert.ok(
    ctx.logger.entries.some(
      (e) => e.message === 'camera catalogue part failed' && JSON.stringify(e).includes('cctvStatusD09'),
    ),
  );
  assert.ok(obs.every((o) => o.provenance.providerId === 'public-cameras-unverified'));
  assert.ok(obs.every((o) => o.externalId.startsWith('caltrans:d')));
  assert.equal((await provider.health()).status, 'LIVE', 'one missing district is not a failed pack');
});

test('unverified provider: every district failing fails the pack', async () => {
  const provider = createUnverifiedProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras-unverified',
    responder: (req) =>
      req.url.includes('cwwp2.dot.ca.gov')
        ? { status: 503 }
        : { status: 200, body: body('unverified/nyc-cameras.json') },
    settings: { packs: { austin: false, iowa: false } },
  });
  await provider.initialize(ctx);
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 2, 'New York still serves');
  const h = await provider.health();
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.message ?? '', /caltrans: HTTP_5XX/);
});

test('each catalogue says how many cameras it gave, once per change', async () => {
  const provider = new PublicCamerasProvider();
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras',
    responder: () => ({ status: 200, body: body('qldtraffic-webcams.geojson') }),
    settings: { packs: Object.fromEntries(PUBLIC_CAMERA_PACKS.map((p) => [p.id, p.id === 'queensland'])) },
  });
  await provider.initialize(ctx);
  await provider.start();
  await provider.query({ signal: new AbortController().signal, background: true });
  await provider.query({ signal: new AbortController().signal, background: true });
  const lines = ctx.logger.entries.filter((e) => e.message === 'camera catalogue');
  assert.equal(lines.length, 1, 'the same count again is not logged again');
  assert.deepEqual(
    { pack: lines[0]!.fields?.['pack'], cameras: lines[0]!.fields?.['cameras'], rows: lines[0]!.fields?.['rows'] },
    { pack: 'queensland', cameras: 3, rows: 6 },
  );
});
