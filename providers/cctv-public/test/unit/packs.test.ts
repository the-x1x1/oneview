import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, ProviderError } from '@worldview/provider-sdk';
import {
  PublicCamerasProvider,
  PUBLIC_CAMERA_PACKS,
  FINTRAFFIC_STATIONS_URL,
  NSW_CAMERAS_URL,
  TFL_JAMCAM_URL,
  ONTARIO_511_CAMERAS_URL,
  DRIVEBC_WEBCAMS_URL,
  CALGARY_CAMERAS_URL,
  HONG_KONG_CAMERAS_URL,
  ICELAND_CAMERAS_URL,
  QLD_WEBCAMS_URL,
  TAIWAN_THB_CCTV_URL,
  DIGITRAFFIC_USER,
  directionToHeading,
  isOnHost,
  normalizeCalgary,
  normalizeDrivebc,
  normalizeFintraffic,
  normalizeNsw,
  normalizeOntario,
  normalizeTfl,
  partnerCredit,
} from '../../src/index.js';

/** Rejection reasons, the off-host detail dropped (offHostReason has its own test). */
const reasons = (r: { rejected: Array<{ reason: string }> }) =>
  r.rejected.map((x) => x.reason.replace(/^(frame url not on the pinned host) \(.*\)$/, '$1'));

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
const FIXTURE_BY_URL: Record<string, string> = {
  [FINTRAFFIC_STATIONS_URL]: 'fintraffic-stations.geojson',
  [NSW_CAMERAS_URL]: 'nsw-traffic-cam.json',
  [TFL_JAMCAM_URL]: 'tfl-jamcam.json',
  [ONTARIO_511_CAMERAS_URL]: 'ontario-511-cameras.json',
  [DRIVEBC_WEBCAMS_URL]: 'drivebc-webcams.json',
  [CALGARY_CAMERAS_URL]: 'calgary-cameras.json',
  [HONG_KONG_CAMERAS_URL]: 'hongkong-cameras.xml',
  [ICELAND_CAMERAS_URL]: 'iceland-webcams.json',
  [QLD_WEBCAMS_URL]: 'qldtraffic-webcams.geojson',
  [TAIWAN_THB_CCTV_URL]: 'taiwan-thb-cctvs.xml',
};
const everyPack = (req: { url: string }) =>
  FIXTURE_BY_URL[req.url] ? { status: 200, body: body(FIXTURE_BY_URL[req.url]!) } : { status: 404 };
const opts = {
  observedAt: '2026-09-21T08:05:00.000Z',
  origin: 'live' as const,
  sourceRef: 'fixture',
  hash: (s: string) => 'a'.repeat(64) + (s.length % 1),
};

test('directionToHeading maps dedicated compass fields only', () => {
  assert.equal(directionToHeading('N'), 0);
  assert.equal(directionToHeading('N-E'), 45);
  assert.equal(directionToHeading('s w'), 225);
  assert.equal(directionToHeading('WESTBOUND'), 270);
  assert.equal(directionToHeading('NNW'), 337.5);
  assert.equal(directionToHeading(''), undefined);
  assert.equal(directionToHeading('WEST AVE'), undefined, 'free text is not a facing');
  assert.equal(directionToHeading(42), undefined);
});

test('fintraffic normalizer builds frame URLs from validated preset ids, never from the payload', () => {
  const payload = JSON.parse(body('fintraffic-stations.geojson')) as {
    features: Array<{ properties: { presets: Array<Record<string, unknown>> } }>;
  };
  payload.features[0]!.properties.presets.push({
    id: 'C0150199',
    inCollection: true,
    imageUrl: 'https://evil.example/x.jpg',
  });
  payload.features[0]!.properties.presets.push({ id: '../../etc', inCollection: true });
  payload.features[0]!.properties.presets.push({ id: 'C9999999', inCollection: true });
  const r = normalizeFintraffic(payload, opts);
  assert.equal(r.drafts.length, 6);
  assert.ok(
    r.drafts.every(
      (d) =>
        String(d.payload['frameUrl']).startsWith('https://weathercam.digitraffic.fi/C') &&
        String(d.payload['frameUrl']).endsWith('.jpg'),
    ),
  );
  assert.equal(r.rejected.length, 2, 'malformed id and foreign-station preset rejected');
  assert.equal(
    r.drafts.find((d) => d.externalId === 'fintraffic:C0150199')?.payload['frameUrl'],
    'https://weathercam.digitraffic.fi/C0150199.jpg',
  );
  assert.equal(normalizeFintraffic({ type: 'Topology' }, opts).malformed, true);
  assert.equal(normalizeFintraffic({ type: 'FeatureCollection', features: 'nope' }, opts).malformed, true);
});

test('nsw normalizer rejects off-host, non-https and credentialed frame URLs', () => {
  const feature = (href: string, id = 'x1') => ({
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [151.2, -33.8] },
    properties: { title: 't', view: 'v', direction: 'N', href },
  });
  const r = normalizeNsw(
    {
      type: 'FeatureCollection',
      features: [
        feature('https://webcams.transport.nsw.gov.au/ok.jpg', 'ok'),
        feature('http://webcams.transport.nsw.gov.au/plain.jpg', 'plain'),
        feature('https://u:p@webcams.transport.nsw.gov.au/creds.jpg', 'creds'),
        feature('https://webcams.transport.nsw.gov.au.evil.example/x.jpg', 'sub'),
        feature('https://webcams.transport.nsw.gov.au/dup.jpg', 'ok'),
        feature('https://data.livetraffic.com/cameras/own.jpg', 'own'),
        feature('https://data.livetraffic.com/other/x.jpg', 'elsewhere'),
      ],
    },
    opts,
  );
  assert.deepEqual(
    r.drafts.map((d) => d.externalId),
    ['nsw:ok', 'nsw:own'],
    "the catalogue host's cameras directory is pinned too; the rest of that host is not",
  );
  assert.equal(r.rejected.length, 5);
});

async function providerWith(responder: testing.FixtureResponder, settings: Record<string, boolean> = {}) {
  const provider = new PublicCamerasProvider();
  const ctx = testing.createFixtureContext({ providerId: 'public-cameras', responder, settings: { packs: settings } });
  await provider.initialize(ctx);
  await provider.start();
  return { provider, ctx };
}

test('provider sends the Digitraffic-User header and only contacts catalog hosts', async () => {
  const { provider, ctx } = await providerWith(everyPack);
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(
    obs.length,
    30,
    'five Fintraffic presets, four NSW, three TfL, two each from Ontario, BC, Calgary, four from Hong Kong, three each from Iceland, Queensland, two from Taiwan’s Highway Bureau (the Freeway Bureau pack is off by default)',
  );
  const fin = ctx.http.requests.find((r) => r.url === FINTRAFFIC_STATIONS_URL);
  assert.equal(fin?.headers?.['Digitraffic-User'], DIGITRAFFIC_USER);
  assert.deepEqual(ctx.http.requests.map((r) => r.url).sort(), Object.keys(FIXTURE_BY_URL).sort(), 'one catalog each');
  assert.equal((await provider.health()).status, 'LIVE');
});

test('one failing pack degrades health while the other pack keeps serving', async () => {
  const { provider, ctx } = await providerWith((req) =>
    req.url === NSW_CAMERAS_URL ? { status: 503 } : { status: 200, body: body('fintraffic-stations.geojson') },
  );
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 5);
  const h = await provider.health();
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.message ?? '', /nsw: HTTP_5XX/);
  assert.equal(h.lastError?.code, 'HTTP_5XX');
  assert.ok(ctx.logger.entries.some((e) => e.level === 'warn' && e.message === 'camera pack failed'));
});

test('all packs failing surfaces a typed ProviderError; disabling packs via settings skips their requests', async () => {
  const { provider } = await providerWith(() => ({ error: 'timeout' }));
  await assert.rejects(
    provider.query({ signal: new AbortController().signal, background: true }),
    (e: unknown) => e instanceof ProviderError && e.code === 'TIMEOUT',
  );
  const only = await providerWith(
    everyPack,
    Object.fromEntries(PUBLIC_CAMERA_PACKS.filter((p) => p.id !== 'fintraffic').map((p) => [p.id, false])),
  );
  const obs = await only.provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 5);
  assert.deepEqual(
    only.ctx.http.requests.map((r) => r.url),
    [FINTRAFFIC_STATIONS_URL],
  );
  assert.deepEqual(
    only.provider.enabledPacks().map((p) => p.id),
    ['fintraffic'],
  );
  const none = await providerWith(
    () => ({ status: 500 }),
    Object.fromEntries(PUBLIC_CAMERA_PACKS.map((p) => [p.id, false])),
  );
  assert.deepEqual(await none.provider.query({ signal: new AbortController().signal, background: true }), []);
  assert.equal((await none.provider.health()).status, 'LIVE');
});

test('stale-served catalogs age the observations and mark origin cached', async () => {
  const provider = new PublicCamerasProvider();
  const clock = new testing.VirtualClock();
  const inner = new testing.FixtureHttp(() => ({ status: 200, body: body('nsw-traffic-cam.json') }), clock);
  const ctx = testing.createFixtureContext({
    providerId: 'public-cameras',
    clock,
    settings: { packs: { fintraffic: false, tfl: false, ontario: false, drivebc: false, calgary: false } },
  });
  const http = {
    request: async (req: Parameters<typeof inner.request>[0]) => ({
      ...(await inner.request(req)),
      stale: true,
      ageMs: 3600_000,
    }),
  };
  await provider.initialize({ ...ctx, http });
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs[0]!.observedAt, new Date(clock.now() - 3600_000).toISOString());
  assert.equal(obs[0]!.provenance.origin, 'cached');
});

test('tfl: available cameras in TfL’s bucket only — the S3 host alone is not a pin', () => {
  const r = normalizeTfl(JSON.parse(body('tfl-jamcam.json')), opts);
  assert.equal(r.total, 5);
  assert.deepEqual(
    r.drafts.map((d) => d.externalId),
    ['tfl:00001.01101', 'tfl:00001.01102', 'tfl:00002.00203'],
  );
  assert.deepEqual(reasons(r), ['frame url not on the pinned host'], 'the other bucket');
  const d = r.drafts[0]!;
  assert.equal(d.payload['frameUrl'], 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.01101.jpg');
  assert.equal(d.payload['name'], 'Invented Rd / Sample St');
  assert.match(String(d.payload['attribution']), /^Powered by TfL Open Data/);
  assert.ok(d.quality.flags?.includes('heading-unknown'), 'JamCams publish no facing');
  const host = ['s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/'];
  assert.equal(isOnHost('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/a.jpg', host), true);
  assert.equal(isOnHost('https://s3-eu-west-1.amazonaws.com/other/a.jpg', host), false);
  assert.equal(isOnHost('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/../other/a.jpg', host), false);
  assert.equal(isOnHost('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/x%2F..%2Fa.jpg', host), false);
  assert.equal(isOnHost('http://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/a.jpg', host), false);
  assert.deepEqual(normalizeTfl({ not: 'an array' }, opts).malformed, true);
});

test('ontario: one camera per site from its best enabled view, frame rebuilt on 511on.ca', () => {
  const r = normalizeOntario(JSON.parse(body('ontario-511-cameras.json')), opts);
  assert.equal(r.total, 5);
  assert.deepEqual(
    r.drafts.map((d) => d.externalId),
    ['ontario:4101', 'ontario:4102'],
  );
  assert.deepEqual(reasons(r), ['invalid coordinates'], 'the site outside Ontario');
  const [north, sample] = r.drafts;
  assert.equal(north!.payload['frameUrl'], 'https://511on.ca/map/Cctv/5101');
  assert.equal(north!.payload['headingDegrees'], 0, 'Northbound');
  assert.equal(north!.payload['name'], 'Invented Expwy near Fixture Ave — Looking north');
  assert.equal(
    sample!.payload['frameUrl'],
    'https://511on.ca/map/Cctv/5104',
    'the view described as down is passed over',
  );
  assert.equal(sample!.payload['headingDegrees'], undefined, '"Unknown" is not a facing');
  assert.equal(normalizeOntario({}, opts).malformed, true);
});

test('drivebc: published cameras, frames built from the id, orientation and elevation, partner credit', () => {
  const r = normalizeDrivebc(JSON.parse(body('drivebc-webcams.json')), opts);
  assert.equal(r.total, 5);
  assert.deepEqual(
    r.drafts.map((d) => d.externalId),
    ['drivebc:13', 'drivebc:682'],
  );
  assert.deepEqual(reasons(r), ['invalid id', 'invalid coordinates']);
  const [border, partner] = r.drafts;
  assert.equal(border!.payload['frameUrl'], 'https://www.drivebc.ca/images/13.jpg', 'never the payload link');
  assert.equal(border!.payload['headingDegrees'], 0);
  assert.equal(border!.position?.altitudeM, 10);
  assert.equal(border!.payload['region'], 'BC border crossings');
  assert.equal(partner!.payload['headingDegrees'], 135, 'orientation is case-insensitive');
  assert.equal(partner!.position?.altitudeM, undefined, 'no elevation, no altitude');
  assert.equal(partner!.payload['credit'], 'Images courtesy of TransLink', 'HTML stripped');
  assert.equal(partnerCredit('<b>Road closed</b>'), '', 'only an owner credit is kept');
});

test('calgary: http frame URLs upgraded and pinned; the quadrant is an address, not a heading', () => {
  const r = normalizeCalgary(JSON.parse(body('calgary-cameras.json')), opts);
  assert.equal(r.total, 4);
  assert.deepEqual(
    r.drafts.map((d) => d.externalId),
    ['calgary:loc142', 'calgary:loc86'],
  );
  assert.deepEqual(reasons(r), ['frame url not on the pinned host', 'invalid coordinates']);
  const d = r.drafts[1]!;
  assert.equal(d.payload['frameUrl'], 'https://trafficcam.calgary.ca/loc86.jpg');
  assert.equal(d.payload['name'], '9 Avenue / 3 Street SE');
  assert.equal(d.payload['headingDegrees'], undefined, '"SE" here is the city quadrant');
  assert.equal(d.payload['quadrant'], 'SE');
  assert.ok(d.quality.flags?.includes('heading-unknown'));
});
