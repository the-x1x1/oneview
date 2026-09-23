import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLinks } from './event-links.js';

test('an event lists the events it names: its replacement, what it replaces, its mainshock', () => {
  assert.deepEqual(eventLinks({}), []);
  assert.deepEqual(eventLinks({ properties: { supersededBy: 'event:weather-alert:nws-alerts:2' } }), [
    { label: 'Replaced by a later message', eventId: 'event:weather-alert:nws-alerts:2' },
  ]);
  assert.deepEqual(
    eventLinks({ properties: { supersedes: ['a', 'b'] } }).map((l) => l.label),
    ['Replaces earlier message 1', 'Replaces earlier message 2'],
  );
  assert.deepEqual(eventLinks({ properties: { mainshockEventId: 'event:earthquake:usgs:m' } }), [
    { label: 'Aftershock of', eventId: 'event:earthquake:usgs:m' },
  ]);
  assert.deepEqual(eventLinks({ properties: { supersedes: 'not a list', supersededBy: 3 } }), []);
});
