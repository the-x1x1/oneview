import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADSB_LOL_MANIFEST } from './manifest.js';
import { aircraftRowToDraft, normalizeAircraftRows, parseAdsbLolResponse } from './normalize.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const opts = { nowMs: NOW, receivedAt: '2026-09-21T08:00:01.000Z', sourceQuality: 'crowdsourced' as const, positionAccuracyM: 100 };

test('normalize: airborne row → barometric altitude, SI motion, trimmed callsign, observedAt = now − seen_pos', () => {
  const d = aircraftRowToDraft({ hex: 'A4B2C3', flight: 'HAL457  ', r: 'N383HA', t: 'a332', alt_baro: 35000, alt_geom: 35900, gs: 470.2, track: 92.4, baro_rate: -64, lat: 21.55, lon: -157.2, seen_pos: 0.8, seen: 0.1, category: 'A5', squawk: '3412', emergency: 'none', dbFlags: 0 }, opts);
  assert.ok(typeof d !== 'string', String(d));
  assert.equal(d.externalId, 'a4b2c3');
  assert.equal(d.observedAt, '2026-09-21T07:59:59.200Z');
  assert.deepEqual(d.position, { latitude: 21.55, longitude: -157.2, altitudeM: 10668, altitudeDatum: 'barometric' });
  assert.equal(d.payload['icao24'], 'a4b2c3');
  assert.equal(d.payload['callsign'], 'HAL457');
  assert.equal(d.payload['typeCode'], 'A332');
  assert.equal(d.payload['speedMps'], 241.89);
  assert.equal(d.payload['verticalSpeedMps'], -0.33);
  assert.equal(d.payload['altitudeGeomM'], 10942.3);
  assert.equal(d.payload['military'], false);
  assert.equal(d.payload['onGround'], false);
  assert.equal(d.payload['seenSeconds'], 0.1);
  assert.equal(d.quality?.flags, undefined);
});

test('normalize: ground row → altitude 0 / ground datum; military bit; stale-position flag', () => {
  const ground = aircraftRowToDraft({ hex: 'a9d8c7', alt_baro: 'ground', lat: 21.32, lon: -157.92, seen_pos: 2, dbFlags: 1 }, opts);
  assert.ok(typeof ground !== 'string');
  assert.equal(ground.payload['onGround'], true);
  assert.equal(ground.payload['military'], true);
  assert.deepEqual(ground.position, { latitude: 21.32, longitude: -157.92, altitudeM: 0, altitudeDatum: 'ground' });
  const stale = aircraftRowToDraft({ hex: 'a7b6c5', alt_baro: 6500, lat: 21.9, lon: -159.35, seen_pos: 75.2 }, opts);
  assert.ok(typeof stale !== 'string');
  assert.deepEqual(stale.quality?.flags, ['stale-position']);
  assert.equal(stale.observedAt, '2026-09-21T07:58:44.800Z');
});

test('normalize: dbFlags bit 1 is the military bit even when other bits are set', () => {
  const d = aircraftRowToDraft({ hex: 'ae1234', lat: 20.8, lon: -158.9, seen_pos: 0, dbFlags: 9 }, opts);
  assert.ok(typeof d !== 'string');
  assert.equal(d.payload['military'], true);
  const e = aircraftRowToDraft({ hex: 'ae1235', lat: 20.8, lon: -158.9, seen_pos: 0, dbFlags: 8 }, opts);
  assert.ok(typeof e !== 'string');
  assert.equal(e.payload['military'], false);
});

test('normalize: TIS-B non-ICAO address never yields icao24 (no false join on aircraft:icao24)', () => {
  const d = aircraftRowToDraft({ hex: '~a5b5c5', type: 'tisb_other', alt_baro: 1200, lat: 21.28, lon: -157.72, seen_pos: 6.2 }, opts);
  assert.ok(typeof d !== 'string');
  assert.equal(d.externalId, 'nonicao-a5b5c5');
  assert.equal(d.payload['icao24'], undefined);
  assert.deepEqual(d.quality?.flags, ['non-icao-address', 'tisb']);
});

test('normalize: rows without a position, invalid hex or invalid coordinates are rejected; garbage optional fields are dropped', () => {
  assert.equal(aircraftRowToDraft({ hex: 'a6c6d6', type: 'mode_s', flight: 'HAL22', alt_baro: 11000, seen: 1.1 }, opts), 'missing position');
  assert.equal(aircraftRowToDraft({ hex: 'zz12', lat: 21.3, lon: -157.9 }, opts), 'invalid hex');
  assert.equal(aircraftRowToDraft({ hex: 'a4b2c3', lat: 121.3, lon: -157.9 }, opts), 'missing position');
  assert.equal(aircraftRowToDraft('nope', opts), 'row not an object');
  const d = aircraftRowToDraft({ hex: 'a4b2c3', lat: 21.3, lon: -157.9, alt_baro: 'abc', gs: 'fast', track: 900, squawk: '9999', category: 'Z9', seen_pos: -5 }, opts);
  assert.ok(typeof d !== 'string');
  assert.deepEqual(d.position, { latitude: 21.3, longitude: -157.9 });
  assert.equal(d.payload['speedMps'], undefined);
  assert.equal(d.payload['headingDegrees'], undefined);
  assert.equal(d.payload['squawk'], undefined);
  assert.equal(d.payload['category'], undefined);
  assert.equal(d.observedAt, '2026-09-21T08:00:00.000Z', 'negative seen_pos clamps to the snapshot time');
});

test('normalizeAircraftRows: duplicates rejected, observations carry manifest provenance and hash', () => {
  const r = normalizeAircraftRows([
    { hex: 'a4b2c3', lat: 21.3, lon: -157.9, seen_pos: 0 },
    { hex: 'A4B2C3', lat: 21.4, lon: -157.8, seen_pos: 0 },
    { hex: 'a0f1e2', lat: 21.1, lon: -158.4, seen_pos: 1 },
  ], ADSB_LOL_MANIFEST, { ...opts, hash: () => 'f'.repeat(64), sourceRef: 'https://api.adsb.lol/v2/lat/21.32/lon/-157.92/dist/150' });
  assert.equal(r.total, 3);
  assert.equal(r.observations.length, 2);
  assert.deepEqual(r.rejected, [{ index: 1, reason: 'duplicate hex a4b2c3' }]);
  const o = r.observations[0]!;
  assert.equal(o.providerId, 'adsb-lol');
  assert.equal(o.id, 'adsb-lol:a4b2c3:2026-09-21T08:00:00.000Z');
  assert.equal(o.provenance.attribution, ADSB_LOL_MANIFEST.attribution.text);
  assert.equal(o.provenance.licenseId, 'ODbL-1.0');
  assert.equal(o.rawPayloadHash, 'f'.repeat(64));
  assert.equal(normalizeAircraftRows('not-a-list', ADSB_LOL_MANIFEST, opts).total, 0);
});

test('parseAdsbLolResponse: requires ac[] and now', () => {
  assert.deepEqual(parseAdsbLolResponse({ ac: [], now: NOW, total: 0 }), { rows: [], nowMs: NOW });
  assert.equal(parseAdsbLolResponse({ states: [] }), 'response has no "ac" array');
  assert.equal(parseAdsbLolResponse({ ac: [] }), 'response has no "now" timestamp');
  assert.equal(parseAdsbLolResponse(null), 'response is not an object');
  assert.equal(parseAdsbLolResponse([]), 'response has no "ac" array');
});
