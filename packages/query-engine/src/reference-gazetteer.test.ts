import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinGazetteer } from './builtin-gazetteer.js';
import { CompositeGazetteer, type PlaceKind } from './gazetteer.js';
import { isReferenceLabelsFile, referenceEntries, referenceGazetteer } from './reference-gazetteer.js';
import { searchWorld } from './search-world.js';
import { FixedClock, stateWith } from './test-fixtures.js';

const file = {
  format: 'worldview-reference-labels@1',
  countries: [
    ['Germany', 9.6783, 50.9617, 1.7, 6.7, 2],
    ['Nowhere', 500, 0, 1, 2, 3],
  ],
  states: [
    ['North Carolina', -78.866, 35.6152, 3.5, 7.5, 0, 'USA'],
    ['Bavaria', 11.3966, 49.0056, 6.6, 11, 3, 'DEU'],
    ['California', -119.591, 36.7496, 3.5, 7.5, 0, 'USA'],
    ['Georgia', -83.4, 32.6, 3.5, 7.5, 0, 'USA'],
    'not a row',
  ],
};

test('reference places: countries and regions from the map label file, bad rows dropped', () => {
  assert.ok(isReferenceLabelsFile(file));
  assert.equal(isReferenceLabelsFile({ format: 'other', countries: [], states: [] }), false);
  const entries = referenceEntries(file);
  assert.deepEqual(
    entries.map((e) => `${e.kind}:${e.name}`),
    ['country:Germany', 'region:North Carolina', 'region:Bavaria', 'region:California', 'region:Georgia'],
  );
  const nc = entries.find((e) => e.name === 'North Carolina')!;
  assert.deepEqual(nc.position, { latitude: 35.6152, longitude: -78.866 });
  assert.equal(nc.countryCode, 'USA');
  assert.equal(nc.id, 'ne:region:USA:north-carolina');
});

test('reference places: what the built-in gazetteer has is left to it; the rest is found by name', () => {
  const builtin = new BuiltinGazetteer();
  const known = (name: string, kind: PlaceKind) =>
    builtin.lookup(name, { kinds: [kind], limit: 1 }).some((h) => h.score >= 1 && h.name === name);
  const ref = referenceGazetteer(file, known);
  const g = new CompositeGazetteer([builtin, ref]);
  const ca = g.lookup('California');
  assert.equal(
    ca.filter((h) => h.name === 'California' && h.kind === 'region').length,
    1,
    'one California, the built-in one',
  );
  assert.equal(g.lookup('North Carolina')[0]?.name, 'North Carolina');
  assert.equal(g.lookup('Bavaria')[0]?.kind, 'region');
  const clock = new FixedClock();
  const results = searchWorld('fly to North Carolina', {
    state: stateWith(clock, []),
    gazetteer: g,
    now: () => clock.now(),
  });
  assert.equal(results[0]?.kind, 'place');
  assert.equal(results[0]?.title, 'North Carolina');
  assert.equal(results[0]?.zoom, 6, 'a state without bounds is framed as a state, not a town');
  const germany = searchWorld('Germany', { state: stateWith(clock, []), gazetteer: g, now: () => clock.now() })[0];
  assert.ok(germany?.bounds || germany?.zoom === 4, 'a country is framed as a country');
});
