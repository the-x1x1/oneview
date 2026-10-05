import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ZONE_EVENT_TYPES, zoneEventTypes } from './watch-zones.js';

test('a new zone listens only for what this installation can raise', () => {
  const known = [
    { type: 'earthquake', label: 'Earthquakes', available: true, objectTypes: ['earthquake'] },
    {
      type: 'launch',
      label: 'Launches',
      available: false,
      unavailableReason: 'No enabled source provides launch',
      objectTypes: ['launch'],
    },
    { type: 'weather-alert', label: 'Weather alerts', available: true, objectTypes: ['weather-alert'] },
  ];
  assert.deepEqual(zoneEventTypes(['earthquake', 'launch', 'weather-alert'], known), ['earthquake', 'weather-alert']);
  assert.deepEqual(
    zoneEventTypes(undefined, known),
    ['earthquake', 'weather-alert'],
    'defaults, filtered the same way',
  );
  assert.deepEqual(
    zoneEventTypes([], null),
    [...DEFAULT_ZONE_EVENT_TYPES],
    'before the runtime has said, the wanted list',
  );
  // A lens whose types none can raise (Maritime's distress beacons, no ship source on): the
  // defaults that can be — never an empty list, which a zone reads as every type.
  assert.deepEqual(zoneEventTypes(['launch'], known), ['earthquake', 'weather-alert']);
  const nothing = known.map((k) => ({ ...k, available: false }));
  assert.deepEqual(
    zoneEventTypes(['launch'], nothing),
    ['launch'],
    'nothing at all: the wanted list, inert but not "every type"',
  );
});
