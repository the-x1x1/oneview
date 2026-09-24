import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEATHERLINK_LOCAL_MANIFEST } from './manifest.js';
import { normalizeConditions, parseCurrentConditions } from './normalize.js';
import { parseWeatherLinkSettings, stationEndpoint } from './index.js';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'weatherlink-local',
);
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const NOW = Date.parse('2026-09-23T20:00:00Z');
const opts = {
  receivedAt: '2026-09-23T20:00:00.000Z',
  nowMs: NOW,
  position: { latitude: 21.3069, longitude: -157.8583 },
  name: 'Backyard',
};

function normalize(name: string, extra: Partial<typeof opts> = {}) {
  const parsed = parseCurrentConditions(load(name));
  assert.ok(typeof parsed !== 'string', String(parsed));
  return normalizeConditions(parsed, WEATHERLINK_LOCAL_MANIFEST, { ...opts, ...extra });
}

test('the envelope: device id and time are read; anything else is refused with a reason', () => {
  const parsed = parseCurrentConditions(load('normal.json'));
  assert.ok(typeof parsed !== 'string');
  assert.equal(parsed.did, '001d0a71a3f2');
  assert.equal(parsed.tsMs, Date.parse('2026-09-23T19:59:30Z'));
  assert.equal(parsed.conditions.length, 4);
  assert.equal(
    parseCurrentConditions(load('error.json')),
    'the device reported an error 409: No ISS Transmitters. Real Time broadcast not enabled',
  );
  assert.match(String(parseCurrentConditions(load('malformed-shape.json'))), /no data/);
  assert.match(String(parseCurrentConditions([])), /not a current_conditions/);
  assert.match(String(parseCurrentConditions({ data: { did: 'x', ts: 1, conditions: [] }, error: null })), /device id/);
  assert.match(String(parseCurrentConditions({ data: { did: '001D0A71A3F2', ts: 'now', conditions: [] } })), /ts/);
});

test('US units in, SI out; the indoor sensor and the soil probes are left in the house', () => {
  const r = normalize('normal.json');
  assert.equal(r.total, 1);
  assert.deepEqual(r.rejected, []);
  const [s] = r.observations;
  assert.equal(s!.externalId, '001d0a71a3f2-1');
  assert.equal(s!.objectType, 'weather-station');
  assert.deepEqual(s!.payload, {
    name: 'Backyard',
    stationId: '001d0a71a3f2',
    temperatureC: 29,
    humidityPct: 62.3,
    dewPointC: 21,
    heatIndexC: 31.6,
    windChillC: 29,
    windSpeedMps: 5,
    windDirDeg: 71,
    windGustMps: 9.4,
    rainRateMmH: 0,
    rainTodayMm: 1,
    rain24hMm: 5.8,
    solarRadiationWm2: 747,
    uvIndex: 8.4,
    reception: 'tracking',
    transmitterId: 1,
    pressureSeaLevelHpa: 1014.8,
    pressureTrend3hHpa: -1,
  });
  assert.equal(s!.quality.sourceQuality, 'authoritative');
  assert.equal(s!.quality.complete, true);
  assert.equal(s!.quality.flags, undefined);
});

test('two transmitters: two stations, named apart; a scanning, low-battery one says so', () => {
  const r = normalize('two-transmitters.json');
  assert.deepEqual(
    r.observations.map((o) => [o.externalId, o.payload['name']]),
    [
      ['001d0a71a3f2-1', 'Backyard (transmitter 1)'],
      ['001d0a71a3f2-2', 'Backyard (transmitter 2)'],
    ],
  );
  const second = r.observations[1]!;
  assert.equal(second.payload['batteryLow'], true);
  assert.equal(second.payload['reception'], 'scanning');
  assert.deepEqual(second.quality.flags, ['battery-low', 'not-receiving']);
  assert.equal(second.payload['rainTodayMm'], 1.2, 'six counts of a 0.2 mm collector');
  assert.equal(second.payload['pressureSeaLevelHpa'], 1014.8, 'the one barometer applies to both');
});

test('bad records are refused one by one; a calm wind has no direction; a device ahead of time is refused', () => {
  const r = normalize('malformed-rows.json');
  assert.equal(r.observations.length, 0);
  assert.equal(r.total, 4);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ['missing or invalid txid', 'no readings', 'not an object', 'missing or invalid txid', 'no readings'],
  );
  const calm = normalizeConditions(
    {
      did: 'abcd1234',
      tsMs: NOW - 5000,
      conditions: [{ data_structure_type: 1, txid: 1, temp: 70, wind_speed_last: 0, wind_dir_last: 0 }],
    },
    WEATHERLINK_LOCAL_MANIFEST,
    opts,
  );
  assert.equal(calm.observations[0]!.payload['windSpeedMps'], 0);
  assert.equal('windDirDeg' in calm.observations[0]!.payload, false);
  const ahead = normalizeConditions(
    { did: 'abcd1234', tsMs: NOW + 3_600_000, conditions: [] },
    WEATHERLINK_LOCAL_MANIFEST,
    opts,
  );
  assert.match(ahead.rejected[0]!.reason, /future/);
  const barOnly = normalizeConditions(
    { did: 'abcd1234', tsMs: NOW, conditions: [{ data_structure_type: 3, bar_sea_level: 30.01, bar_trend: 0 }] },
    WEATHERLINK_LOCAL_MANIFEST,
    opts,
  );
  assert.equal(barOnly.observations[0]!.externalId, 'abcd1234-base', 'no outdoor suite: the barometer still reports');
  assert.equal(barOnly.observations[0]!.payload['pressureSeaLevelHpa'], 1016.3);
});

test('settings: nothing is contacted until the address and the position are both set', () => {
  assert.deepEqual(parseWeatherLinkSettings({}), { name: 'Weather station' });
  const none = stationEndpoint(parseWeatherLinkSettings({}));
  assert.equal(none.ok, false);
  assert.match(!none.ok ? none.reason : '', /address/);
  const noPos = stationEndpoint(parseWeatherLinkSettings({ host: '192.168.1.50' }));
  assert.match(!noPos.ok ? noPos.reason : '', /latitude and longitude/);
  const ok = stationEndpoint(
    parseWeatherLinkSettings({ host: ' WLL.local ', latitude: '21.3', longitude: -157.8, name: '  Roof ' }),
  );
  assert.deepEqual(ok, { ok: true, url: 'http://wll.local/v1/current_conditions', host: 'wll.local', trusted: true });
  assert.equal(parseWeatherLinkSettings({ latitude: 95 }).latitude, undefined);
  assert.equal(parseWeatherLinkSettings({ name: 'Roof' }).name, 'Roof');
  const bad = stationEndpoint(parseWeatherLinkSettings({ host: 'a b', latitude: 1, longitude: 1 }));
  assert.equal(bad.ok, false, 'a host that is not a host is refused');
});

test('with no address set the source reads NEEDS_SETUP, not ERROR, and sends nothing', async () => {
  const { createProvider } = await import('./index.js');
  const { testing } = await import('@worldview/provider-sdk');
  const provider = createProvider();
  let requests = 0;
  const ctx = testing.createFixtureContext({
    providerId: provider.manifest.id,
    responder: () => {
      requests++;
      return { status: 404 };
    },
  });
  await provider.initialize(ctx);
  await provider.start();
  await assert.rejects(provider.query!({ signal: new AbortController().signal, background: true }), (e: unknown) =>
    Boolean((e as { setupRequired?: boolean }).setupRequired),
  );
  assert.equal((await provider.health()).status, 'NEEDS_SETUP');
  assert.equal(requests, 0);
});
