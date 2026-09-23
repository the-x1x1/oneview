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
});
