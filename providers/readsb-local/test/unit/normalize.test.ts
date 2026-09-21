import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READSB_LOCAL_MANIFEST } from '../../src/manifest.js';
import { aircraftRowToDraft, normalizeAircraftRows, parseReadsbAircraftJson } from '../../src/normalize.js';

const NOW = Date.parse('2026-09-21T08:00:00.000Z');
const opts = { nowMs: NOW, receivedAt: '2026-09-21T08:00:01.000Z', sourceQuality: 'authoritative' as const, origin: 'local' as const };

test('parseReadsbAircraftJson: seconds → ms, message counter, shape errors', () => {
  assert.deepEqual(parseReadsbAircraftJson({ now: 1789977600.4, messages: 12, aircraft: [] }), { rows: [], nowMs: 1789977600400, messages: 12 });
  assert.deepEqual(parseReadsbAircraftJson({ now: 1789977600, aircraft: [] }), { rows: [], nowMs: 1789977600000 });
  assert.equal(parseReadsbAircraftJson({ ac: [], now: 1 }), 'aircraft.json has no "aircraft" array');
  assert.equal(parseReadsbAircraftJson({ aircraft: [] }), 'aircraft.json has no "now" timestamp');
  assert.equal(parseReadsbAircraftJson('x'), 'aircraft.json is not an object');
});

test('normalize: receiver rows → observations with local origin, rssi and seen ages', () => {
  const r = normalizeAircraftRows([
    { hex: 'a12b34', flight: 'HAL9    ', alt_baro: 12025, gs: 312.4, track: 84.9, baro_rate: 2048, lat: 21.3689, lon: -157.7412, seen_pos: 0.3, seen: 0.1, rssi: -9.8, squawk: '1341', category: 'A3' },
    { hex: 'ab1c2d', type: 'mode_s', flight: 'HAL482', alt_baro: 9000, seen: 1.9 },
  ], READSB_LOCAL_MANIFEST, opts);
  assert.equal(r.total, 2);
  assert.equal(r.observations.length, 1);
  assert.deepEqual(r.rejected, [{ index: 1, reason: 'missing position' }]);
  const o = r.observations[0]!;
  assert.equal(o.providerId, 'readsb-local');
  assert.equal(o.provenance.origin, 'local');
  assert.equal(o.observedAt, '2026-09-21T07:59:59.700Z');
  assert.equal(o.payload['rssiDb'], -9.8);
  assert.equal(o.payload['seenSeconds'], 0.1);
  assert.equal(o.payload['seenPositionSeconds'], 0.3);
  assert.equal(o.payload['callsign'], 'HAL9');
  assert.equal(o.position?.altitudeM, 3665.2);
  assert.equal(o.rawPayloadHash, undefined, 'no hash function → no hash');
});

test('normalize: ground, military, non-ICAO and stale-position rules match adsb-remote', () => {
  const ground = aircraftRowToDraft({ hex: 'a9e0f1', alt_baro: 'ground', lat: 21.32, lon: -157.93, seen_pos: 5.8, dbFlags: 3 }, opts);
  assert.ok(typeof ground !== 'string');
  assert.deepEqual(ground.position, { latitude: 21.32, longitude: -157.93, altitudeM: 0, altitudeDatum: 'ground' });
  assert.equal(ground.payload['military'], true);
  const tisb = aircraftRowToDraft({ hex: '~a90b12', type: 'tisb_other', lat: 21.3, lon: -157.86, seen_pos: 70 }, opts);
  assert.ok(typeof tisb !== 'string');
  assert.equal(tisb.externalId, 'nonicao-a90b12');
  assert.equal(tisb.payload['icao24'], undefined);
  assert.deepEqual(tisb.quality?.flags, ['stale-position', 'non-icao-address', 'tisb']);
});

test('duplicate normalizer stays in step with providers/adsb-remote (row rules are byte-identical)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mine = readFileSync(path.resolve(here, '..', '..', 'src', 'normalize.ts'), 'utf8');
  const theirs = readFileSync(path.resolve(here, '..', '..', '..', 'adsb-remote', 'src', 'normalize.ts'), 'utf8');
  const rules = (src: string) => src.slice(src.indexOf('export const FOOT_TO_M'), src.indexOf('/** adsb.lol v2 envelope') >= 0 ? src.indexOf('/** adsb.lol v2 envelope') : src.indexOf('/** readsb aircraft.json envelope'));
  assert.equal(rules(mine), rules(theirs), 'aircraft row rules diverged between readsb-local and adsb-remote');
});
