import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromWire, isJsonWire, responseToWire, toWire, worldDeltaWireParts } from './event-wire.js';

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

test('event wire: bulk world responses are encoded; every other response, and an empty one, is not', () => {
  const snapshot = { snapshot: [satellite], count: 1 };
  const wire = responseToWire('world.subscribe', snapshot);
  assert.ok(isJsonWire(wire));
  assert.deepEqual(fromWire(wire), snapshot);
  const present = { present: true };
  assert.equal(responseToWire('credentials.has', present), present);
  assert.equal(responseToWire('world.subscribe', undefined), undefined, 'nothing to encode');
});

test('event wire: a delta is split by size as well as count, each object encoded once, and adds up', () => {
  const big = 'x'.repeat(300_000);
  const objects = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `weather-alert:nws:${i}`, geometry: big })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `satellite:norad:${i}` })),
  ];
  const whole = {
    added: objects.slice(0, 3).map((o) => o.id),
    updated: objects.slice(3).map((o) => o.id),
    removed: ['aircraft:icao24:gone'],
    refreshed: [],
    at: '2026-09-21T00:00:00Z',
    objectCount: 15,
    objects,
    freshness: [],
  };
  const parts = worldDeltaWireParts(whole, { maxBytes: 700_000 }).map((p) => fromWire<typeof whole>(p));
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  for (const p of parts) assert.ok(JSON.stringify(p.objects).length < 1_000_000);
  assert.deepEqual(
    parts.flatMap((p) => p.objects),
    objects,
    'every object, once, in order, unchanged',
  );
  assert.deepEqual(
    parts.flatMap((p) => p.added),
    whole.added,
  );
  assert.deepEqual(
    parts.flatMap((p) => p.updated),
    whole.updated,
  );
  assert.deepEqual(
    parts.flatMap((p) => p.removed),
    whole.removed,
    'removals once',
  );
  assert.ok(parts.every((p) => p.at === whole.at && p.objectCount === 15));

  // An object bigger than the limit still goes, alone.
  const huge = worldDeltaWireParts({
    ...whole,
    objects: [{ id: 'a', g: 'y'.repeat(2_000_000) }],
    added: ['a'],
    updated: [],
  });
  assert.equal(huge.length, 1);

  // Small deltas are one message, exactly as before.
  const small = { ...whole, objects: objects.slice(5), added: [], updated: objects.slice(5).map((o) => o.id) };
  assert.deepEqual(worldDeltaWireParts(small), [{ wvJson: JSON.stringify(small) }]);
});
