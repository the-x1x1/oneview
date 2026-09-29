import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRCRAFT_CLASSES,
  AIRCRAFT_CLASS_ICON,
  AIRCRAFT_CLASS_LABELS,
  aircraftClass,
  aircraftIcon,
  classFromType,
} from './aircraft-class.js';
import { ICON_IDS } from './icons.js';

test('classFromType: common designators of each class', () => {
  const cases: Array<[string, string | undefined]> = [
    ['A320', undefined], // narrow-body: the jet is the default, not a table entry
    ['B77W', 'heavy'],
    ['A388', 'heavy'],
    ['A359', 'heavy'],
    ['A306', 'heavy'],
    ['C17', 'heavy'],
    ['K35R', 'heavy'],
    ['AT76', 'turboprop'],
    ['DH8D', 'turboprop'],
    ['C130', 'turboprop'],
    ['B350', 'turboprop'],
    ['C208', 'turboprop'],
    ['C172', 'light'],
    ['P28A', 'light'],
    ['SR22', 'light'],
    ['H60', 'helicopter'],
    ['EC35', 'helicopter'],
    ['AS50', 'helicopter'],
    ['B407', 'helicopter'],
    ['R44', 'helicopter'],
    ['C25A', 'business'],
    ['GLF6', 'business'],
    ['LJ45', 'business'],
    ['F2TH', 'business'],
    ['E55P', 'business'],
    ['F16', 'fast-jet'],
    ['EUFI', 'fast-jet'],
    ['F35', 'fast-jet'],
    ['GLID', 'glider'],
    ['BALL', 'balloon'],
    ['Q9', 'uav'],
    ['B461', undefined], // BAe 146 — not a Bell helicopter
    ['A318', undefined], // not an A310
    ['../x', undefined],
  ];
  for (const [type, want] of cases) assert.equal(classFromType(type), want, type);
});

test('aircraftClass: a known designator decides, else the emitter category, else the generic jet', () => {
  assert.equal(aircraftClass({ typeCode: 'B738', category: 'A3' }), 'jet');
  assert.equal(aircraftClass({ typeCode: 'H60', category: 'A3' }), 'helicopter', 'a known designator wins');
  assert.equal(aircraftClass({ typeCode: 'ZZZ9', category: 'A5' }), 'heavy', 'an unlisted type, a heavy category');
  assert.equal(aircraftClass({ typeCode: 'ZZZ9', category: 'A1' }), 'light', 'an unlisted type, a light category');
  assert.equal(aircraftClass({ typeCode: 'ZZZ9' }), 'jet', 'an unlisted type and no category: the generic jet');
  assert.equal(aircraftClass({ category: 'A7' }), 'helicopter');
  assert.equal(aircraftClass({ category: 'a1' }), 'light', 'case-insensitive');
  assert.equal(aircraftClass({ category: 'B2' }), 'balloon');
  assert.equal(aircraftClass({ category: 'B6' }), 'uav');
  assert.equal(aircraftClass({ category: 'C1' }), 'unknown', 'a surface vehicle is no class of aircraft');
  assert.equal(aircraftClass({}), 'unknown');
  assert.equal(aircraftClass({ aircraftType: 'B789' }), 'heavy', 'aircraftType is read when typeCode is absent');
  assert.equal(aircraftIcon({ typeCode: 'A388' }), 'aircraft-heavy');
  assert.equal(aircraftIcon({}), 'aircraft', 'unknown keeps the generic jet');
  assert.equal(aircraftIcon({ typeCode: 'C56X', category: 'A2' }), 'aircraft-business');
});

test('every class has an icon in the shared set and a label', () => {
  for (const c of AIRCRAFT_CLASSES) {
    assert.ok((ICON_IDS as readonly string[]).includes(AIRCRAFT_CLASS_ICON[c]), c);
    assert.ok(AIRCRAFT_CLASS_LABELS[c].length > 0);
  }
  const distinct = new Set(AIRCRAFT_CLASSES.filter((c) => c !== 'unknown').map((c) => AIRCRAFT_CLASS_ICON[c]));
  assert.equal(distinct.size, AIRCRAFT_CLASSES.length - 1, 'one silhouette per class');
});
