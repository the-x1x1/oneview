import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaticStore, flagFields, messageToDraft } from './normalize.js';

// Invented ship (a made-up MMSI in the Netherlands' 244 block) — no real vessel is described.
const MMSI = 244123456;

test('voyage data a ship broadcast (type 5) reaches its next position, with the flag its MMSI implies', () => {
  const store = new StaticStore();
  const receivedMs = Date.parse('2026-09-27T10:00:30Z');
  assert.equal(
    messageToDraft(
      {
        type: 5,
        mmsi: MMSI,
        imo: 9876543,
        callSign: 'PABC',
        shipName: 'TEST TRADER',
        shipType: 71,
        dimensions: { toBow: 150, toStern: 40, toPort: 15, toStarboard: 15 },
        eta: { month: 10, day: 2, hour: 6, minute: 30 },
        draughtM: 11.2,
        destination: 'NLRTM',
      },
      store,
      { receivedMs },
    ).kind,
    'static',
  );
  const out = messageToDraft(
    { type: 1, mmsi: MMSI, accuracy: true, latitude: 51.9, longitude: 3.9, speedKnots: 12, courseDeg: 80, second: 20 },
    store,
    { receivedMs },
  );
  assert.ok(out.kind === 'position');
  const p = out.draft.payload;
  assert.equal(p['flag'], 'Netherlands');
  assert.equal(p['flagMid'], '244');
  assert.equal(p['destination'], 'NLRTM');
  assert.deepEqual(p['eta'], { month: 10, day: 2, hour: 6, minute: 30 });
  assert.equal(p['imo'], '9876543');
  assert.equal(p['callSign'], 'PABC');
  assert.equal(p['shipTypeText'], 'cargo');
  assert.equal(p['lengthM'], 190);
  assert.equal(p['beamM'], 30);
  assert.equal(p['draughtM'], 11.2);
});

test('flagFields matches the AISStream provider: kind only for non-ships, nothing for an unallocated MID', () => {
  assert.deepEqual(flagFields('244123456'), { flag: 'Netherlands', flagMid: '244' });
  assert.deepEqual(flagFields('002440001'), { mmsiKind: 'coast-station', flag: 'Netherlands', flagMid: '244' });
  assert.deepEqual(flagFields('974123456'), { mmsiKind: 'emergency-device' });
  assert.deepEqual(flagFields('200000001'), {});
});
