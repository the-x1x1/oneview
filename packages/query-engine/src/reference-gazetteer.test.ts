import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinGazetteer } from './builtin-gazetteer.js';
import { CompositeGazetteer, type PlaceKind } from './gazetteer.js';
import {
  cityEntries,
  isReferenceLabelsFile,
  isReferencePlacesFile,
  populationImportance,
  referenceEntries,
  referenceGazetteer,
} from './reference-gazetteer.js';
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

const places = {
  format: 'worldview-reference-places@1',
  cities: [
    ['Paris', 2.3314, 48.8686, 'FR', 'Île-de-France', 9904000, 1, ''],
    ['Kansas City', -94.606, 39.109, 'US', 'Missouri', 1469000, 0, ''],
    ['Springfield', -89.65, 39.82, 'US', 'Illinois', 134715, 0, ''],
    ['Springfield', -72.58, 42.12, 'US', 'Massachusetts', 421780, 0, ''],
    ['Paris', -95.5555, 33.6609, 'US', 'Texas', 25171, 0, ''],
    ['Mumbai', 72.855, 19.0189, 'IN', 'Maharashtra', 18978000, 0, 'Bombay'],
    ['Helsinki', 24.9322, 60.1775, 'FI', 'Southern Finland', 1115000, 1, ''],
    ['Broken', 200, 0, 'XX', '', 1, 0, ''],
    ['Short row', 1, 1],
  ],
};

test('reference cities: populated places become cities with region, country and importance', () => {
  assert.ok(isReferencePlacesFile(places));
  assert.equal(isReferencePlacesFile(file), false, 'the label file is not a places file');
  const entries = cityEntries(places);
  assert.equal(entries.length, 7, 'a row off the globe and a short row are dropped');
  const helsinki = entries.find((e) => e.name === 'Helsinki')!;
  assert.equal(helsinki.kind, 'city');
  assert.equal(helsinki.countryCode, 'FI');
  assert.equal(helsinki.region, 'Southern Finland');
  assert.deepEqual(helsinki.position, { latitude: 60.1775, longitude: 24.9322 });
  assert.equal(helsinki.id, 'ne:city:FI:southern-finland:helsinki');
  assert.ok(populationImportance(1_000_000) > populationImportance(25_000));
  assert.equal(populationImportance(0), 0);
  assert.equal(populationImportance(40_000_000), 1);
});

test('reference cities: the larger place first among names that match the same way; former names match', () => {
  const g = new CompositeGazetteer([new BuiltinGazetteer(), referenceGazetteer(file, () => false, places)]);
  const paris = g.lookup('Paris', { kinds: ['city'] });
  assert.equal(paris[0]?.countryCode, 'FR', 'Paris, France before Paris, Texas');
  assert.equal(paris.filter((h) => h.countryCode === 'FR' || h.countryCode === 'FRA').length, 1, 'one Paris, France');
  assert.ok(
    paris.some((h) => h.region === 'Texas'),
    'Paris, Texas is still offered',
  );
  const springfield = g.lookup('Springfield');
  assert.deepEqual(
    springfield.map((h) => h.region),
    ['Massachusetts', 'Illinois'],
  );
  assert.equal(g.lookup('Bombay')[0]?.name, 'Mumbai');
  assert.equal(g.lookup('Helsinki')[0]?.name, 'Helsinki');

  const clock = new FixedClock();
  const results = searchWorld('Springfield', { state: stateWith(clock, []), gazetteer: g, now: () => clock.now() });
  const placesFound = results.filter((r) => r.kind === 'place');
  assert.deepEqual(
    placesFound.map((r) => r.subtitle),
    ['City · Massachusetts · US', 'City · Illinois · US'],
    'the subtitle tells two Springfields apart',
  );
  assert.ok(placesFound[0]!.score > placesFound[1]!.score);
  const kc = searchWorld('fly to Kansas City', { state: stateWith(clock, []), gazetteer: g, now: () => clock.now() });
  assert.equal(kc[0]?.title, 'Kansas City');
  assert.equal(kc[0]?.zoom, 10, 'framed as a city');
});
