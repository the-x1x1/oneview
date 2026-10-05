import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Collection, WatchZone } from '@worldview/ipc-contract';
import { ownPlaceResults } from './own-places-search.js';

const at = '2026-10-05T00:00:00.000Z';
const collections: Collection[] = [
  {
    id: 'trip',
    name: 'Big Island trip',
    createdAt: at,
    updatedAt: at,
    items: [
      {
        id: 'a',
        kind: 'location',
        title: 'Mauna Kea summit',
        createdAt: at,
        updatedAt: at,
        position: { latitude: 19.82, longitude: -155.47 },
        tags: ['observatory'],
      },
      {
        id: 'b',
        kind: 'object',
        title: 'Mauna Loa aircraft',
        objectId: 'aircraft:x',
        createdAt: at,
        updatedAt: at,
        position: { latitude: 19.5, longitude: -155.6 },
      },
      { id: 'c', kind: 'location', title: 'No position', createdAt: at, updatedAt: at },
    ],
  },
];
const zones: WatchZone[] = [
  {
    id: 'z1',
    name: 'Kīlauea summit',
    geometry: { kind: 'circle', center: { latitude: 19.41, longitude: -155.28 }, radiusM: 20_000 },
    eventTypes: ['earthquake'],
    notifications: { inApp: true, desktop: false },
    enabled: false,
    createdAt: at,
  },
];

test("search finds the operator's own places: collected locations by title and tag, watch zones by name", () => {
  const mk = ownPlaceResults(collections, zones, 'mauna', 10);
  assert.deepEqual(
    mk.map((r) => [r.id, r.title, r.subtitle]),
    [['collection:trip:a', 'Mauna Kea summit', 'Collected · Big Island trip']],
    'a collected object is found as itself in the world, not here',
  );
  assert.equal(mk[0]!.kind, 'place');
  assert.equal(mk[0]!.zoom, 13);
  assert.equal(ownPlaceResults(collections, zones, 'observatory', 10)[0]?.title, 'Mauna Kea summit', 'by tag');
  const zone = ownPlaceResults(collections, zones, 'kilauea', 10)[0]!;
  assert.equal(zone.id, 'watchzone:z1');
  assert.equal(zone.subtitle, 'Watch zone · paused');
  assert.ok(zone.bounds && zone.bounds.north > 19.41 && zone.bounds.south < 19.41, 'framed by the zone');
  const exact = ownPlaceResults(collections, zones, 'Mauna Kea summit', 10)[0]!;
  assert.equal(exact.score, 1);
  assert.deepEqual(ownPlaceResults(collections, zones, '   ', 10), []);
  assert.deepEqual(ownPlaceResults([], [], 'mauna', 10), []);
});
