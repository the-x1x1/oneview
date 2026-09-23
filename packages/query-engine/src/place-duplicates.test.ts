import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '@worldview/ipc-contract';
import { BuiltinGazetteer } from './builtin-gazetteer.js';
import { CompositeGazetteer, StaticGazetteer } from './gazetteer.js';
import { collapseDuplicatePlaces, placeResultKind, samePlace } from './place-duplicates.js';
import { searchWorld } from './search-world.js';
import { FixedClock, stateWith } from './test-fixtures.js';

const honolulu = { latitude: 21.3069, longitude: -157.8583 };
const hnl = { latitude: 21.3187, longitude: -157.9224 };

test('the same place: same kind, same name once normalized, within the radius for its kind', () => {
  const city = { name: 'Honolulu', kind: 'city' as const, position: honolulu };
  assert.ok(samePlace(city, { ...city, name: 'HONOLULU', position: { latitude: 21.31, longitude: -157.83 } }));
  assert.ok(samePlace({ ...city, name: 'São Paulo' }, { ...city, name: 'Sao Paulo' }), 'accents ignored');
  assert.ok(!samePlace(city, { ...city, kind: 'region' }), 'a county of the same name is another place');
  assert.ok(!samePlace(city, { ...city, position: { latitude: 21.5, longitude: -158.1 } }), '~33 km apart');
  const airport = { name: 'Daniel K. Inouye International Airport', kind: 'airport' as const, position: hnl };
  assert.ok(samePlace(airport, { ...airport, position: { latitude: 21.33, longitude: -157.92 } }), '~1.3 km');
  assert.ok(!samePlace(airport, { ...airport, position: { latitude: 21.36, longitude: -157.92 } }), '~4.6 km');
  const here = { name: '21.3, -157.8', kind: 'coordinate' as const, position: honolulu };
  assert.ok(!samePlace(here, here), 'coordinates are never collapsed');
});

test('two gazetteers listing Honolulu under two ids give one hit, carrying what either knew', () => {
  const pack = new StaticGazetteer(
    [
      {
        id: 'place:hawaii-test:honolulu',
        name: 'Honolulu',
        kind: 'city',
        position: { latitude: 21.309, longitude: -157.861 },
      },
      {
        id: 'airport:hawaii-test:hnl',
        name: 'Daniel K. Inouye International Airport',
        kind: 'airport',
        position: { latitude: 21.32, longitude: -157.925 },
        countryCode: 'US',
      },
    ],
    'worldpack',
  );
  const g = new CompositeGazetteer([pack, new BuiltinGazetteer()]);
  const cities = g.lookup('Honolulu').filter((h) => h.kind === 'city');
  assert.equal(cities.length, 1, JSON.stringify(cities));
  assert.equal(cities[0]!.countryCode, 'US', 'the built-in entry’s country code is kept');
  const airports = g.lookup('Daniel K. Inouye International Airport').filter((h) => h.kind === 'airport');
  assert.equal(airports.length, 1, JSON.stringify(airports));
});

test('search results: a later duplicate folds into the first, which keeps the better score and subtitle', () => {
  const r = (id: string, subtitle: string, score: number, extra: Partial<SearchResult> = {}): SearchResult => ({
    kind: 'place',
    id,
    title: id.includes('hnl') ? 'Daniel K. Inouye International Airport' : 'Honolulu',
    subtitle,
    position: id.includes('hnl') ? hnl : honolulu,
    source: 'local-index',
    score,
    ...extra,
  });
  const out = collapseDuplicatePlaces([
    r('place:builtin:honolulu', 'City · US', 0.95, { zoom: 10 }),
    r('airport:pack:hnl', 'Airport · US', 0.9),
    r('place:pack:honolulu', 'City · US', 0.97, {
      source: 'worldpack',
      bounds: { west: -158, south: 21.2, east: -157.6, north: 21.5 },
    }),
    r('airport:pack2:hnl', 'Airport · HNL · US', 0.8),
    { kind: 'query', id: 'query:honolulu', title: 'Objects "honolulu"', source: 'parser', score: 0.5 },
  ]);
  assert.deepEqual(
    out.map((x) => [x.id, x.subtitle, x.score, x.source]),
    [
      ['place:pack:honolulu', 'City · US', 0.97, 'worldpack'],
      ['airport:pack:hnl', 'Airport · HNL · US', 0.9, 'local-index'],
      ['query:honolulu', undefined, 0.5, 'parser'],
    ],
    'the pack record wins where a pack knows the place; the order stays',
  );
  assert.ok(out[0]!.bounds, 'the pack’s bounds');

  const zoomed = collapseDuplicatePlaces([
    r('place:builtin:honolulu', 'City · US', 0.95, { zoom: 10 }),
    r('place:other:honolulu', 'City', 0.9, { bounds: { west: -158, south: 21.2, east: -157.6, north: 21.5 } }),
  ]);
  assert.equal(zoomed.length, 1);
  assert.equal(zoomed[0]!.id, 'place:builtin:honolulu');
  assert.ok(zoomed[0]!.bounds && zoomed[0]!.zoom === undefined, 'bounds taken, point zoom dropped');
});

test('the kind a result names: both producers’ labels are read', () => {
  const p = (subtitle: string): SearchResult => ({
    kind: 'place',
    id: 'x',
    title: 'x',
    subtitle,
    source: 'worldpack',
    score: 1,
  });
  assert.equal(placeResultKind(p('City · US')), 'city');
  assert.equal(placeResultKind(p('Poi')), 'poi');
  assert.equal(placeResultKind(p('Feature · IS')), 'poi');
  assert.equal(placeResultKind(p('Place')), 'poi');
  assert.equal(placeResultKind(p('Coordinates')), undefined);
});

test('searchWorld answers "Honolulu" with one Honolulu when two indexes know it', () => {
  const pack = new StaticGazetteer(
    [
      {
        id: 'place:hawaii-test:honolulu',
        name: 'Honolulu',
        kind: 'city',
        position: { latitude: 21.309, longitude: -157.861 },
      },
    ],
    'worldpack',
  );
  const clock = new FixedClock();
  const results = searchWorld('Honolulu', {
    state: stateWith(clock, []),
    gazetteer: new CompositeGazetteer([pack, new BuiltinGazetteer()]),
    now: () => clock.now(),
  });
  assert.equal(results.filter((x) => x.kind === 'place' && x.title === 'Honolulu').length, 1);
});
