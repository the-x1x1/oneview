import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromWire, isJsonWire, toWire } from './event-wire.js';

const satellite = {
  id: 'satellite:norad:25544',
  type: 'satellite',
  sourceRefs: [
    {
      observationId: 'celestrak:25544:2026-09-21T03:12:34.123Z',
      providerId: 'celestrak',
      observedAt: '2026-09-21T03:12:34.123Z',
    },
  ],
  observedAt: '2026-09-21T03:12:34.123Z',
  updatedAt: '2026-09-21T04:14:49.123Z',
  freshness: 'LIVE',
  confidence: 0.715,
  labels: { name: 'ISS (ZARYA)' },
  properties: {
    noradId: 25544,
    eccentricity: 0.0006703,
    bstar: -1.2e-5,
    classification: 'U',
    decayed: false,
    tags: ['a', 'b'],
  },
  provenance: {
    providerId: 'celestrak',
    sourceName: 'CelesTrak',
    origin: 'live',
    receivedAt: '2026-09-21T04:14:49.123Z',
  },
  position: { latitude: -18.027984194106427, longitude: 168.77146167293301, altitudeM: 424403, altitudeDatum: 'orbit' },
  motion: { speedMps: 7658.8, headingDegrees: 38 },
};
const delta = {
  added: [],
  updated: [satellite.id],
  removed: ['aircraft:icao24:abc123'],
  refreshed: [],
  at: '2026-09-21T04:14:49.123Z',
  objectCount: 8101,
  objects: [satellite],
  freshness: [{ id: 'x', freshness: 'STALE' }],
};

test('event wire: a world delta crosses as one JSON string and comes back exactly as it was sent', () => {
  const wire = toWire('world.changed', delta);
  assert.ok(isJsonWire(wire));
  assert.equal(typeof (wire as { wvJson: string }).wvJson, 'string');
  assert.deepEqual(fromWire(wire), delta, 'coordinates to the last digit, negative exponents, booleans, nested arrays');
});

test('event wire: every other event is sent as it is', () => {
  const settings = { firstRunCompleted: true, textScale: 1 };
  assert.equal(toWire('settings.changed', settings), settings, 'the very same object — nothing is encoded');
  assert.equal(fromWire(settings), settings);
  // Only the exact wire shape is decoded: a payload that happens to have a wvJson field and
  // anything else is left alone.
  const lookalike = { wvJson: '{}', other: 1 };
  assert.equal(isJsonWire(lookalike), false);
  assert.equal(fromWire(lookalike), lookalike);
  assert.equal(isJsonWire(null), false);
  assert.equal(isJsonWire('{"wvJson":"x"}'), false);
});
