import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCatalogNumber, orbitSummary, parseCatalog, parseOmmJson, parseTleText, tleChecksum, tleToElements, ommEpochToIso, intlDesignatorFromTle } from './elements.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'celestrak');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

test('OMM JSON and TLE fixtures decode to the same element sets', () => {
  const json = parseOmmJson(JSON.parse(body('normal.json')));
  const tle = parseTleText(body('normal.tle'));
  assert.equal(json.rejected.length, 0);
  assert.equal(tle.rejected.length, 0);
  assert.equal(json.elements.length, 12);
  assert.equal(tle.elements.length, 12);
  for (let i = 0; i < 12; i++) {
    const a = json.elements[i]!, b = tle.elements[i]!;
    assert.equal(a.noradId, b.noradId);
    assert.equal(a.name, b.name);
    assert.equal(a.intlDesignator, b.intlDesignator);
    assert.ok(Math.abs(Date.parse(a.epoch) - Date.parse(b.epoch)) < 10, `${a.name} epoch ${a.epoch} vs ${b.epoch}`);
    assert.ok(Math.abs(a.meanMotion - b.meanMotion) < 1e-8);
    assert.ok(Math.abs(a.eccentricity - b.eccentricity) < 1e-7);
    assert.ok(Math.abs(a.inclination - b.inclination) < 1e-4);
    assert.ok(Math.abs(a.raan - b.raan) < 1e-4);
    assert.ok(Math.abs(a.meanAnomaly - b.meanAnomaly) < 1e-4);
    assert.ok(Math.abs((a.bstar ?? 0) - (b.bstar ?? 0)) < 1e-9, `${a.name} bstar ${a.bstar} vs ${b.bstar}`);
    assert.equal(typeof b.line1, 'string');
    assert.equal(a.line1, undefined);
  }
  const iss = json.elements.find((e) => e.noradId === 25544)!;
  assert.equal(iss.epoch, '2026-09-21T03:12:34.123Z');
  assert.equal(iss.classification, 'U');
  assert.equal(iss.elementSetNo, 999);
});

test('TLE checksum, Alpha-5 catalog numbers and designators', () => {
  const l1 = '1 25544U 98067A   26264.13372828  .00016717  00000+0  10270-3 0  9998';
  assert.equal(tleChecksum(l1), 8);
  assert.equal(decodeCatalogNumber('25544'), 25544);
  assert.equal(decodeCatalogNumber('A0001'), 100_001);
  assert.equal(decodeCatalogNumber('Z9999'), 339_999);
  assert.equal(decodeCatalogNumber('I0001'), undefined);
  assert.equal(intlDesignatorFromTle('98067A  '), '1998-067A');
  assert.equal(intlDesignatorFromTle('21035A  '), '2021-035A');
  assert.equal(ommEpochToIso('2026-09-21T03:12:34.123456'), '2026-09-21T03:12:34.123Z');
  assert.equal(ommEpochToIso('2026-09-21T03:12:34Z'), '2026-09-21T03:12:34.000Z');
  assert.equal(ommEpochToIso('yesterday'), undefined);
});

test('malformed TLE records are rejected individually', () => {
  const r = parseTleText(body('malformed-checksum.tle'));
  assert.equal(r.total, 3);
  assert.equal(r.elements.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.reason).sort(), ['TLE checksum mismatch', 'TLE line too short'].sort());
  assert.equal(typeof tleToElements('X', 'garbage', 'garbage'), 'string');
  assert.equal(parseTleText('').rejected[0]?.index, -1);
});

test('malformed OMM rows reject with reasons; whole-body problems reject at index -1', () => {
  const rows = parseCatalog(body('malformed-rows.json'), 'json');
  assert.equal(rows.total, 8);
  assert.equal(rows.elements.length, 2, 'duplicate row is only removed by the normalizer');
  assert.deepEqual(rows.rejected.map((x) => x.reason), ['missing NORAD_CAT_ID', 'invalid EPOCH', 'mean motion out of range', 'eccentricity out of range', 'missing orbital elements', 'record not an object']);
  assert.equal(parseCatalog(body('malformed-shape.json'), 'json').rejected[0]?.index, -1);
  assert.equal(parseCatalog(body('malformed-notfound.txt'), 'json').rejected[0]?.reason, 'not valid JSON');
  assert.equal(parseCatalog('', 'json').rejected[0]?.index, -1);
  assert.deepEqual(parseCatalog(body('empty.json'), 'json'), { elements: [], total: 0, rejected: [] });
});

test('orbit summary: ISS ≈ 93 min / ~420 km, GOES ≈ 1436 min / ~35,800 km', () => {
  const json = parseOmmJson(JSON.parse(body('normal.json')));
  const iss = orbitSummary(json.elements.find((e) => e.noradId === 25544)!);
  assert.ok(Math.abs(iss.periodMinutes - 92.9) < 0.2, String(iss.periodMinutes));
  assert.ok(iss.perigeeKm > 400 && iss.apogeeKm < 440, `${iss.perigeeKm}/${iss.apogeeKm}`);
  const goes = orbitSummary(json.elements.find((e) => e.noradId === 41866)!);
  assert.ok(Math.abs(goes.periodMinutes - 1436.1) < 0.5, String(goes.periodMinutes));
  assert.ok(goes.apogeeKm > 35_700 && goes.apogeeKm < 35_900, String(goes.apogeeKm));
});
