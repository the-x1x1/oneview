import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSatcatRecords, restoreSatcatEntry, satcatEntryToJson, satcatProperties, satcatUrl } from './satcat.js';

/*
 * FIXTURES ARE HAND-WRITTEN, not copies of CelesTrak responses (CelesTrak publishes no
 * licence for redistributing its data, so none is recorded here). They follow the field
 * list of https://celestrak.org/satcat/satcat-format.php; the facts in them (the ISS's
 * launch date and site, Vanguard 1's) are public history, and the orbit numbers are
 * illustrative. Types vary on purpose: numbers as numbers and as strings, empties as null
 * and as "".
 */
const ISS_RECORD = {
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  NORAD_CAT_ID: 25544,
  OBJECT_TYPE: 'PAY',
  OPS_STATUS_CODE: '+',
  OWNER: 'ISS',
  LAUNCH_DATE: '1998-11-20',
  LAUNCH_SITE: 'TYMSC',
  DECAY_DATE: null,
  PERIOD: 92.9,
  INCLINATION: 51.64,
  APOGEE: 422,
  PERIGEE: 415,
  RCS: null,
  DATA_STATUS_CODE: null,
  ORBIT_CENTER: 'EA',
  ORBIT_TYPE: 'ORB',
};

const DECAYED_RB = {
  OBJECT_NAME: 'SL-4 R/B',
  OBJECT_ID: '1990-001B',
  NORAD_CAT_ID: '99990',
  OBJECT_TYPE: 'R/B',
  OPS_STATUS_CODE: 'D',
  OWNER: 'CIS',
  LAUNCH_DATE: '1990-01-01',
  LAUNCH_SITE: 'PLMSC',
  DECAY_DATE: '1990-01-15',
  PERIOD: '',
  INCLINATION: '62.8',
  APOGEE: '',
  PERIGEE: '',
  RCS: '4.5',
  DATA_STATUS_CODE: 'NCE',
  ORBIT_CENTER: 'EA',
  ORBIT_TYPE: 'IMP',
};

test('satcatUrl: one record by catalogue number, JSON', () => {
  assert.equal(satcatUrl(25544), 'https://celestrak.org/satcat/records.php?CATNR=25544&FORMAT=JSON');
});

test('parseSatcatRecords: the documented fields, codes spelled out', () => {
  const r = parseSatcatRecords([ISS_RECORD], 25544)!;
  assert.equal(r.owner, 'ISS');
  assert.equal(r.launchDate, '1998-11-20');
  assert.equal(r.decayDate, undefined);
  const p = satcatProperties(r);
  assert.equal(p['objectTypeText'], 'Payload');
  assert.equal(p['opsStatusText'], 'Operational');
  assert.equal(p['ownerName'], 'International Space Station partners');
  assert.equal(p['launchSiteName'], 'Baikonur Cosmodrome (Tyuratam), Kazakhstan');
  assert.equal(p['satcatPeriodMinutes'], 92.9);
  assert.equal(p['orbitTypeText'], 'In orbit');
  assert.equal(p['rcsM2'], undefined);
  assert.ok(!('decayDate' in p));
});

test('parseSatcatRecords: strings for numbers, empties, a decayed rocket body', () => {
  const r = parseSatcatRecords([ISS_RECORD, DECAYED_RB], 99990)!;
  assert.equal(r.name, 'SL-4 R/B');
  assert.equal(r.objectType, 'R/B');
  assert.equal(r.inclination, 62.8);
  assert.equal(r.periodMinutes, undefined);
  assert.equal(r.apogeeKm, undefined);
  assert.equal(r.rcsM2, 4.5);
  const p = satcatProperties(r);
  assert.equal(p['objectTypeText'], 'Rocket body');
  assert.equal(p['opsStatusText'], 'Decayed');
  assert.equal(p['decayDate'], '1990-01-15');
  assert.equal(p['dataStatusText'], 'No current elements');
  assert.equal(p['orbitTypeText'], 'Impacted');
  assert.equal(p['launchSiteName'], 'Plesetsk Cosmodrome, Russia');
});

test('parseSatcatRecords: nothing for another number, garbage, or an empty answer; bad fields dropped', () => {
  assert.equal(parseSatcatRecords([ISS_RECORD], 1), undefined);
  assert.equal(parseSatcatRecords([], 25544), undefined);
  assert.equal(parseSatcatRecords('No GP data found', 25544), undefined);
  assert.equal(parseSatcatRecords(null, 25544), undefined);
  const odd = parseSatcatRecords(
    [{ ...ISS_RECORD, LAUNCH_DATE: '20 Nov 1998', OWNER: '<script>', INCLINATION: 400, OBJECT_TYPE: 'PAYLOAD-X' }],
    25544,
  )!;
  assert.equal(odd.launchDate, undefined);
  assert.equal(odd.owner, undefined);
  assert.equal(odd.inclination, undefined);
  assert.equal(odd.objectType, undefined);
  assert.equal(odd.launchSite, 'TYMSC');
  // An unknown code is kept as the code, with no spelled-out name.
  const p = satcatProperties({ ...parseSatcatRecords([ISS_RECORD], 25544)!, owner: 'ZZZ' });
  assert.equal(p['owner'], 'ZZZ');
  assert.equal(p['ownerName'], undefined);
});

test('a docked object says what it is docked to', () => {
  const r = parseSatcatRecords(
    [{ ...ISS_RECORD, NORAD_CAT_ID: 49044, ORBIT_CENTER: '25544', ORBIT_TYPE: 'DOC' }],
    49044,
  )!;
  const p = satcatProperties(r);
  assert.equal(p['dockedTo'], 25544);
  assert.equal(p['orbitTypeText'], 'Docked');
});

test('cache entries round-trip and are re-validated', () => {
  const r = parseSatcatRecords([ISS_RECORD], 25544)!;
  assert.deepEqual(restoreSatcatEntry(satcatEntryToJson({ record: r }), 25544), { record: r });
  assert.deepEqual(restoreSatcatEntry(satcatEntryToJson({ none: true }), 25544), { none: true });
  assert.equal(restoreSatcatEntry({ record: { noradId: 1 } }, 25544), undefined, 'another object');
  assert.equal(restoreSatcatEntry('x', 25544), undefined);
});
