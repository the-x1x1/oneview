import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import {
  PUBLIC_CAMERA_FRAME_HOSTS,
  PUBLIC_CAMERA_PACKS,
  PUBLIC_CAMERAS_MANIFEST,
  PUBLIC_CAMERAS_UNVERIFIED_MANIFEST,
  PublicCamerasProvider,
  UNVERIFIED_CAMERA_PACKS,
  US_511_CAMERA_URLS,
  US_511_CREDENTIALS,
  US_511_PACKS,
  createUnverifiedProvider,
  dgtPack,
  illinoisCamerasUrl,
  illinoisPack,
  ILLINOIS_PAGE_SIZE,
  lks94ToWgs84,
  normalizeDgt,
  normalizeIllinois,
  normalizeLithuania,
  normalizeOntario,
  normalizeWsdot,
} from '../../src/index.js';

/**
 * The catalogues added on 2026-09-27: IDOT Gateway (Illinois) and DGT (Spain) in
 * `public-cameras`; Washington State DOT, Lithuania (eismoinfo.lt) and the keyed 511 sites
 * of New York State, Utah, Arizona, Georgia and Idaho in `public-cameras-unverified`.
 * Every fixture is invented in the published shape (fixtures/cctv-public/README.md).
 */
const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'cctv-public',
);
const json = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const opts = {
  observedAt: '2026-09-21T08:05:00.000Z',
  origin: 'live' as const,
  sourceRef: 'fixture',
  hash: (s: string) => 'c'.repeat(63) + (s.length % 10),
};
const ids = (r: { drafts: Array<{ externalId: string }> }) => r.drafts.map((d) => d.externalId);
const byId = (r: { drafts: Array<{ externalId: string; payload: Record<string, unknown> }> }, id: string) =>
  r.drafts.find((d) => d.externalId === id);
const reasons = (r: { rejected: Array<{ reason: string }> }) =>
  r.rejected.map((x) => x.reason.replace(/^(frame url not on the pinned host) \(.*\)$/, '$1'));

test('dgt: stills only under eTraffic’s camera directory, http upgraded, province from the INE code', () => {
  const r = normalizeDgt(json('dgt-camaras.json'), opts);
  assert.deepEqual(ids(r), ['dgt:9001', 'dgt:9002', 'dgt:9003']);
  assert.equal(r.total, 7);
  assert.deepEqual(reasons(r), [
    'frame url not on the pinned host',
    'invalid coordinates',
    'duplicate id 9001',
    'invalid id "../x"',
  ]);
  const a = byId(r, 'dgt:9001')!;
  assert.equal(a.payload['name'], 'A-62 km 57.9');
  assert.equal(a.payload['region'], 'Palencia, Spain');
  assert.equal(a.payload['frameUrl'], 'https://etraffic.dgt.es/camarasEtraffic/9001.jpg');
  assert.equal(a.payload['headingDegrees'], undefined, 'sentido is a kilometre-post direction, not a facing');
  const canary = byId(r, 'dgt:9002')!;
  assert.equal(canary.payload['frameUrl'], 'https://etraffic.dgt.es/camarasEtraffic/9002.jpg');
  assert.equal(canary.payload['region'], 'Santa Cruz de Tenerife, Spain');
  const bare = byId(r, 'dgt:9003')!;
  assert.equal(bare.payload['name'], 'DGT camera 9003', 'numeric id, no road');
  assert.equal(bare.payload['region'], 'Spain', 'unknown province code');
  assert.equal(normalizeDgt([], opts).malformed, true);
  assert.equal(normalizeDgt({ camaras: [] }, opts).total, 0);
  assert.equal(dgtPack.offByDefault, true, 'off until the camera list’s own licence is read');
});

test('illinois: pages merged, one camera per device and facing, snapshot directory pinned', () => {
  const r = normalizeIllinois(
    [json('illinois-page-0.json'), json('illinois-page-1.json'), json('illinois-page-empty.json')],
    opts,
  );
  assert.deepEqual(ids(r), [
    'illinois:IL-INVENTED-D1-0001.S',
    'illinois:IL-INVENTED-D1-0001.W',
    'illinois:IL-INVENTED-D1-0002',
    'illinois:IL-INVENTED-D4-0100.E',
  ]);
  assert.deepEqual(reasons(r), [
    'frame url not on the pinned host',
    'invalid id "https://example.com/else"…',
    'invalid coordinates',
    'duplicate id IL-INVENTED-D1-0002',
  ]);
  const south = byId(r, 'illinois:IL-INVENTED-D1-0001.S')!;
  assert.equal(south.payload['headingDegrees'], 180);
  assert.equal(south.payload['name'], 'Invented Rd at Fixture Expwy — facing S');
  assert.equal(south.payload['device'], 'IL-INVENTED-D1-0001');
  assert.match(String(south.payload['attribution']), /CC BY-SA 2\.0$/);
  const none = byId(r, 'illinois:IL-INVENTED-D1-0002')!;
  assert.equal(none.payload['headingDegrees'], undefined, 'NONE is not a facing');
  assert.equal(
    none.payload['frameUrl'],
    'https://cctv.travelmidwest.com/snapshots/IL-INVENTED-D1_0002_NONE.jpg',
    'http upgraded',
  );
  // A last page that still says there is more is reported, not passed off as the whole list.
  const cut = normalizeIllinois([json('illinois-page-0.json')], opts);
  assert.ok(reasons(cut).some((x) => /exceededTransferLimit/.test(x)));
  assert.ok(!reasons(r).some((x) => /exceededTransferLimit/.test(x)), 'only the last page counts');
  assert.equal(normalizeIllinois({ error: { message: 'Token Required' } }, opts).malformed, true);
  assert.equal(illinoisPack.moreRequests?.length, 5);
  assert.equal(illinoisPack.moreRequests?.[0]?.url, illinoisCamerasUrl(ILLINOIS_PAGE_SIZE));
  assert.match(illinoisCamerasUrl(0), /orderByFields=OBJECTID&resultOffset=0&resultRecordCount=1000/);
});

test('illinois: a partner agency’s cameras on their own host are left out and counted, not rejected', () => {
  const row = (id: string, snap: string) => ({
    attributes: {
      ImgPath: `https://travelmidwest.com/showCamera?id=${id}&direction=E`,
      CameraLocation: 'Invented Rd',
      CameraDirection: 'E',
      SnapShot: snap,
    },
    geometry: { x: -87.9, y: 42.3 },
  });
  const r = normalizeIllinois(
    {
      features: [
        row('IL-INVENTED-D1-0009', 'https://cctv.travelmidwest.com/snapshots/IL-INVENTED-D1_0009_E.jpg'),
        row('IL-LAKECOUNTY-00001', 'https://www.lakecountypassage.com/snapshots/Invented_East_Leg.jpg'),
        row('IL-LAKECOUNTY-00002', 'https://www.lakecountypassage.com/snapshots/Invented_West_Leg.jpg'),
        row('IL-ELSEWHERE-00003', 'https://images.example.com/cam.jpg'),
        row(
          'IL-INVENTED-ST00-(HD-Fixture-at-Sample-Drive)',
          'https://cctv.travelmidwest.com/snapshots/IL-INVENTED-ST00.jpg',
        ),
      ],
    },
    opts,
  );
  assert.deepEqual(
    ids(r),
    ['illinois:IL-INVENTED-D1-0009.E', 'illinois:IL-INVENTED-ST00-_HD-Fixture-at-Sample-Drive.E'],
    'a site in parentheses is kept, its brackets made safe for an id',
  );
  assert.deepEqual(r.excluded, { 'Lake County PASSAGE (no licence on record)': 2 });
  assert.deepEqual(reasons(r), ['frame url not on the pinned host'], 'an unknown host is still a rejection');
});

test('wsdot: WSDOT’s own image host only, compass field to heading, one page checked for truncation', () => {
  const r = normalizeWsdot(json('unverified/wsdot-cameras.json'), opts);
  assert.deepEqual(ids(r), ['wsdot:9101', 'wsdot:9102', 'wsdot:9103']);
  assert.deepEqual(reasons(r), ['frame url not on the pinned host', 'invalid coordinates']);
  assert.equal(byId(r, 'wsdot:9101')!.payload['headingDegrees'], 0);
  assert.equal(byId(r, 'wsdot:9103')!.payload['headingDegrees'], 90);
  assert.equal(
    byId(r, 'wsdot:9102')!.payload['frameUrl'],
    'https://images.wsdot.wa.gov/rweather/Medium_SamplePass.jpg',
  );
  const cut = normalizeWsdot({ features: [], exceededTransferLimit: true }, opts);
  assert.ok(reasons(cut).some((x) => /exceededTransferLimit/.test(x)));
  assert.equal(normalizeWsdot([], opts).malformed, true);
});

test('lks94ToWgs84: the inverse Transverse Mercator lands where Lithuania is', () => {
  const origin = lks94ToWgs84(500000, 0)!;
  assert.ok(Math.abs(origin.latitude) < 1e-9 && Math.abs(origin.longitude - 24) < 1e-9, 'origin on 24° E');
  // Central meridian: latitude from the meridian arc alone; 6,000 km of arc (÷ 0.9998) is ~54.0° N.
  const onMeridian = lks94ToWgs84(500000, 6_000_000)!;
  assert.equal(onMeridian.longitude, 24);
  assert.ok(onMeridian.latitude > 54.0 && onMeridian.latitude < 54.2, String(onMeridian.latitude));
  // A camera row 10 km out of Vilnius on the A1 (x 576154, y 6056867).
  const a1 = lks94ToWgs84(576154, 6056867)!;
  assert.ok(Math.abs(a1.latitude - 54.6426) < 1e-3 && Math.abs(a1.longitude - 25.1798) < 1e-3, JSON.stringify(a1));
  assert.equal(lks94ToWgs84(Number.NaN, 1), undefined);
});

test('lithuania: frame rebuilt from the numeric id, LKS94 converted, bad rows refused', () => {
  const r = normalizeLithuania(json('unverified/lithuania-cameras.json'), opts);
  assert.deepEqual(ids(r), ['lithuania:9072', 'lithuania:9008']);
  assert.deepEqual(reasons(r), [
    'invalid id "9009"',
    'invalid coordinates',
    'invalid coordinates',
    'duplicate id 9072',
  ]);
  const a = byId(r, 'lithuania:9072')!;
  assert.equal(a.payload['frameUrl'], 'https://eismoinfo.lt/eismoinfo-backend/image-provider/camera/last?id=9072');
  assert.equal(a.payload['region'], 'A1 Vilnius–Kaunas–Klaipėda');
  assert.equal(
    byId(r, 'lithuania:9008')!.payload['frameUrl'],
    'https://eismoinfo.lt/eismoinfo-backend/image-provider/camera/last?id=9008',
    'the image field of the row is ignored',
  );
  assert.equal(normalizeLithuania({}, opts).malformed, true);
});

test('511 platform: the Ontario reader and the US sites share one normalizer; frames rebuilt on each site', () => {
  const udot = US_511_PACKS.find((p) => p.id === 'udot')!;
  const r = udot.normalize(json('unverified/udot-cameras.json'), opts);
  assert.deepEqual(ids(r), ['udot:9151', 'udot:9152']);
  assert.deepEqual(reasons(r), ['invalid coordinates']);
  const a = byId(r, 'udot:9151')!;
  assert.equal(a.payload['frameUrl'], 'https://www.udottraffic.utah.gov/map/Cctv/9160');
  assert.equal(a.payload['headingDegrees'], 0);
  const b = byId(r, 'udot:9152')!;
  assert.equal(
    b.payload['frameUrl'],
    'https://www.udottraffic.utah.gov/map/Cctv/9162',
    'a down view is passed over; an http view on the bare host is rebuilt on https',
  );
  assert.equal(b.payload['name'], 'Sample St @ 400 E — Looking East');
  const ny = US_511_PACKS.find((p) => p.id === 'ny511')!.normalize(json('unverified/ny511-cameras.json'), opts);
  assert.deepEqual(ids(ny), ['ny511:9201']);
  assert.match(String(byId(ny, 'ny511:9201')!.payload['attribution']), /^Powered by 511NY/);
  // A Utah catalogue read as Ontario's is refused row by row (off-host views, out of bounds).
  assert.equal(normalizeOntario(json('unverified/udot-cameras.json'), opts).drafts.length, 0);
  // Every site: keyed request, key in the query, its own host pinned, catalogue on that host.
  for (const pack of US_511_PACKS) {
    assert.equal(pack.request.credential?.as, 'query');
    assert.equal(pack.request.credential?.name, 'key');
    assert.equal(pack.request.credential?.key, US_511_CREDENTIALS[pack.id]);
    assert.equal(pack.request.url, US_511_CAMERA_URLS[pack.id]);
    assert.equal(new URL(pack.request.url).hostname, pack.frameHosts[0]);
    assert.ok(
      PUBLIC_CAMERAS_UNVERIFIED_MANIFEST.credentials.some((c) => c.key === US_511_CREDENTIALS[pack.id]),
      `${pack.id}: credential declared`,
    );
    assert.ok(PUBLIC_CAMERAS_UNVERIFIED_MANIFEST.allowedHosts.includes(pack.frameHosts[0]!));
  }
});

test('the 511 packs wait for their keys; the keyless unverified packs run', async () => {
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras-unverified',
    credentials: ['udot.apiKey'],
    settings: {
      packs: Object.fromEntries(UNVERIFIED_CAMERA_PACKS.map((p) => [p.id, ['udot', 'ny511', 'wsdot'].includes(p.id)])),
    },
    responder: (req) =>
      req.url.includes('udottraffic')
        ? { status: 200, body: JSON.stringify(json('unverified/udot-cameras.json')) }
        : { status: 200, body: JSON.stringify(json('unverified/wsdot-cameras.json')) },
  });
  const p = createUnverifiedProvider();
  await p.initialize(ctx);
  await p.start();
  const obs = await p.query({ signal: new AbortController().signal, background: true });
  assert.deepEqual(
    [...new Set(obs.map((o) => o.payload['pack']))].sort(),
    ['udot', 'wsdot'],
    'New York waits for its key',
  );
  assert.deepEqual([...p.waitingForKey], ['ny511']);
  assert.match((await p.health()).message ?? '', /ny511: needs an API key/);
  const udotReq = ctx.http.requests.find((r) => r.url.includes('udottraffic'))!;
  assert.deepEqual(udotReq.credential, { key: 'udot.apiKey', as: 'query', name: 'key' });
  assert.ok(!udotReq.url.includes('key='), 'the key is never in the URL the provider builds');
});

test('new packs: settings, hosts and gateway frame hosts line up with the pack lists', async () => {
  const settingKeys = (m: { settings?: Array<{ key: string }> }) => (m.settings ?? []).map((s) => s.key);
  for (const pack of PUBLIC_CAMERA_PACKS)
    assert.ok(settingKeys(PUBLIC_CAMERAS_MANIFEST).includes(`packs.${pack.id}`), `${pack.id} has a setting`);
  for (const pack of UNVERIFIED_CAMERA_PACKS)
    assert.ok(settingKeys(PUBLIC_CAMERAS_UNVERIFIED_MANIFEST).includes(`packs.${pack.id}`), `${pack.id} has a setting`);
  for (const pack of [illinoisPack, dgtPack])
    assert.ok(PUBLIC_CAMERAS_MANIFEST.allowedHosts.includes(new URL(pack.request.url).hostname));
  assert.deepEqual(PUBLIC_CAMERA_FRAME_HOSTS['illinois'], ['cctv.travelmidwest.com/snapshots/']);
  assert.deepEqual(PUBLIC_CAMERA_FRAME_HOSTS['dgt'], ['etraffic.dgt.es/camarasEtraffic/']);
  // DGT stays off unless turned on; Illinois is on.
  const provider = new PublicCamerasProvider();
  await provider.initialize(testing.createFixtureContext({ providerId: 'public-cameras' }));
  const on = provider.enabledPacks().map((p) => p.id);
  assert.ok(on.includes('illinois'));
  assert.ok(!on.includes('dgt'));
});
