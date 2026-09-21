import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, ProviderError } from '@worldview/provider-sdk';
import { PublicCamerasProvider, FINTRAFFIC_STATIONS_URL, NSW_CAMERAS_URL, DIGITRAFFIC_USER, directionToHeading, normalizeFintraffic, normalizeNsw } from '../../src/index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'cctv-public');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const opts = { observedAt: '2026-09-21T08:05:00.000Z', origin: 'live' as const, sourceRef: 'fixture', hash: (s: string) => 'a'.repeat(64) + s.length % 1 };

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
  const payload = JSON.parse(body('fintraffic-stations.geojson')) as { features: Array<{ properties: { presets: Array<Record<string, unknown>> } }> };
  payload.features[0]!.properties.presets.push({ id: 'C0150199', inCollection: true, imageUrl: 'https://evil.example/x.jpg' });
  payload.features[0]!.properties.presets.push({ id: '../../etc', inCollection: true });
  payload.features[0]!.properties.presets.push({ id: 'C9999999', inCollection: true });
  const r = normalizeFintraffic(payload, opts);
  assert.equal(r.drafts.length, 6);
  assert.ok(r.drafts.every((d) => String(d.payload['frameUrl']).startsWith('https://weathercam.digitraffic.fi/C') && String(d.payload['frameUrl']).endsWith('.jpg')));
  assert.equal(r.rejected.length, 2, 'malformed id and foreign-station preset rejected');
  assert.equal(r.drafts.find((d) => d.externalId === 'fintraffic:C0150199')?.payload['frameUrl'], 'https://weathercam.digitraffic.fi/C0150199.jpg');
  assert.equal(normalizeFintraffic({ type: 'Topology' }, opts).malformed, true);
  assert.equal(normalizeFintraffic({ type: 'FeatureCollection', features: 'nope' }, opts).malformed, true);
});

test('nsw normalizer rejects off-host, non-https and credentialed frame URLs', () => {
  const feature = (href: string, id = 'x1') => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [151.2, -33.8] }, properties: { title: 't', view: 'v', direction: 'N', href } });
  const r = normalizeNsw({ type: 'FeatureCollection', features: [
    feature('https://webcams.transport.nsw.gov.au/ok.jpg', 'ok'),
    feature('http://webcams.transport.nsw.gov.au/plain.jpg', 'plain'),
    feature('https://u:p@webcams.transport.nsw.gov.au/creds.jpg', 'creds'),
    feature('https://webcams.transport.nsw.gov.au.evil.example/x.jpg', 'sub'),
    feature('https://webcams.transport.nsw.gov.au/dup.jpg', 'ok'),
  ] }, opts);
  assert.deepEqual(r.drafts.map((d) => d.externalId), ['nsw:ok']);
  assert.equal(r.rejected.length, 4);
});

async function providerWith(responder: testing.FixtureResponder, settings: Record<string, boolean> = {}) {
  const provider = new PublicCamerasProvider();
  const ctx = testing.createFixtureContext({ providerId: 'public-cameras', responder, settings: { packs: settings } });
  await provider.initialize(ctx);
  await provider.start();
  return { provider, ctx };
}

test('provider sends the Digitraffic-User header and only contacts catalog hosts', async () => {
  const { provider, ctx } = await providerWith((req) => ({ status: 200, body: body(req.url === FINTRAFFIC_STATIONS_URL ? 'fintraffic-stations.geojson' : 'nsw-traffic-cam.json') }));
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 9);
  const fin = ctx.http.requests.find((r) => r.url === FINTRAFFIC_STATIONS_URL);
  assert.equal(fin?.headers?.['Digitraffic-User'], DIGITRAFFIC_USER);
  assert.ok(ctx.http.requests.every((r) => /^https:\/\/(tie\.digitraffic\.fi|data\.livetraffic\.com)\//.test(r.url)), 'catalog hosts only; frames are never fetched by the provider');
});

test('one failing pack degrades health while the other pack keeps serving', async () => {
  const { provider, ctx } = await providerWith((req) => req.url === NSW_CAMERAS_URL ? { status: 503 } : { status: 200, body: body('fintraffic-stations.geojson') });
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
  await assert.rejects(provider.query({ signal: new AbortController().signal, background: true }), (e: unknown) => e instanceof ProviderError && e.code === 'TIMEOUT');
  const only = await providerWith((req) => ({ status: 200, body: body(req.url === FINTRAFFIC_STATIONS_URL ? 'fintraffic-stations.geojson' : 'nsw-traffic-cam.json') }), { nsw: false });
  const obs = await only.provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 5);
  assert.deepEqual(only.ctx.http.requests.map((r) => r.url), [FINTRAFFIC_STATIONS_URL]);
  assert.deepEqual(only.provider.enabledPacks().map((p) => p.id), ['fintraffic']);
  const none = await providerWith(() => ({ status: 500 }), { nsw: false, fintraffic: false });
  assert.deepEqual(await none.provider.query({ signal: new AbortController().signal, background: true }), []);
  assert.equal((await none.provider.health()).status, 'LIVE');
});

test('stale-served catalogs age the observations and mark origin cached', async () => {
  const provider = new PublicCamerasProvider();
  const clock = new testing.VirtualClock();
  const inner = new testing.FixtureHttp(() => ({ status: 200, body: body('nsw-traffic-cam.json') }), clock);
  const ctx = testing.createFixtureContext({ providerId: 'public-cameras', clock, settings: { packs: { fintraffic: false } } });
  const http = { request: async (req: Parameters<typeof inner.request>[0]) => ({ ...(await inner.request(req)), stale: true, ageMs: 3600_000 }) };
  await provider.initialize({ ...ctx, http });
  await provider.start();
  const obs = await provider.query({ signal: new AbortController().signal, background: true });
  assert.equal(obs[0]!.observedAt, new Date(clock.now() - 3600_000).toISOString());
  assert.equal(obs[0]!.provenance.origin, 'cached');
});
