import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import { cpa, cpaText, ownVesselOf } from './cpa.js';

const vessel = (id: string, lat: number, lon: number, course: number, knots: number, own = false): WorldObject => ({
  id,
  type: 'vessel',
  sourceRefs: [],
  position: { latitude: lat, longitude: lon },
  motion: { speedMps: (knots * 1852) / 3600, headingDegrees: course },
  observedAt: '2026-10-05T19:00:00.000Z',
  updatedAt: '2026-10-05T19:00:00.000Z',
  freshness: 'LIVE',
  confidence: 0.9,
  labels: {},
  properties: { courseDegrees: course, ...(own ? { ownVessel: true } : {}) },
  provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: '2026-10-05T19:00:00.000Z' },
});

test('two ships on crossing courses: the closest point, and when', () => {
  // The boat at 21.0° N 158.0° W heading north at 10 kn; a ship 5 nm east heading west at 10 kn.
  const own = vessel('own', 21, -158, 0, 10, true);
  const ship = vessel('ship', 21, -158 + 5 / (60 * Math.cos((21 * Math.PI) / 180)), 270, 10);
  const c = cpa(own, ship)!;
  // Relative motion is 14.1 kn on 225°: the ship passes 3.54 nm off, 15 minutes from now.
  // Five minutes of longitude on the ellipsoid at 21° N are 5.01 nm (a minute at the equator is 1,855 m).
  assert.ok(Math.abs(c.rangeM / 1852 - 5.011) < 0.002, `${c.rangeM / 1852}`);
  assert.ok(Math.abs(c.cpaM / 1852 - 5.011 / Math.SQRT2) < 0.005, `${c.cpaM / 1852}`);
  assert.ok(Math.abs(c.tcpaS / 60 - 15.03) < 0.05, `${c.tcpaS / 60}`);
  assert.equal(c.opening, false);
  assert.equal(c.close, false);
  assert.equal(cpaText(c), '5.0 nm 090° E · CPA 3.5 nm in 15 min');
});

test('head on is close; going away is opening; the boat is found among the nearby objects', () => {
  const own = vessel('own', 21, -158, 0, 8, true);
  const ahead = vessel('ahead', 21 + 2 / 60, -158, 180, 8);
  const c = cpa(own, ahead)!;
  assert.equal(c.close, true, '2 nm ahead, head on: nearest (0 nm) in 7.5 min');
  assert.ok(c.cpaM < 10);
  assert.match(cpaText(c), /CPA 0\.0 nm in (7|8) min$/);
  const astern = vessel('astern', 21 - 2 / 60, -158, 180, 8);
  assert.equal(cpa(own, astern)!.opening, true);
  assert.match(cpaText(cpa(own, astern)!), /· opening$/);
  assert.equal(ownVesselOf([ahead, own, astern])?.id, 'own');
  assert.equal(ownVesselOf([ahead, astern]), undefined);
  assert.equal(cpa(own, { ...ahead, motion: {}, properties: {} }), undefined, 'no course or speed: none');
});

test('course over ground, not heading; a vessel lying still needs no course', () => {
  const own = vessel('own', 21, -158, 0, 8, true);
  const crabbing = { ...vessel('x', 21 + 2 / 60, -158, 180, 8), properties: {} };
  assert.equal(cpa(own, crabbing), undefined, 'a heading alone is where it points, not where it goes');
  const anchored = { ...vessel('anchored', 21 + 2 / 60, -158, 0, 0), properties: { speedMps: 0 } };
  const c = cpa(own, anchored)!;
  assert.ok(Math.abs(c.tcpaS / 60 - 15) < 0.2, 'the boat reaches it in 15 min at 8 kn');
  assert.equal(c.close, true);
});

test('each is carried forward from when it was last heard; too old says nothing; together, the range holds', () => {
  // The ship was heard two minutes before the boat, 5 nm east then; heading west at 10 kn it
  // has since come a third of a mile closer.
  const own = { ...vessel('own', 21, -158, 0, 0, true), observedAt: '2026-10-05T19:02:00.000Z' };
  const ship = vessel('ship', 21, -158 + 5 / (60 * Math.cos((21 * Math.PI) / 180)), 270, 10);
  const now = Date.parse('2026-10-05T19:02:00.000Z');
  const c = cpa(own, ship, now)!;
  assert.ok(Math.abs(c.rangeM / 1852 - (5.011 - 10 / 30)) < 0.005, `${c.rangeM / 1852}`);
  assert.ok(c.cpaM < 10 && c.close, 'straight at the boat, 28 min away');
  assert.match(cpaText(c), /· CPA 0\.0 nm in 28 min$/);
  assert.equal(cpa(own, ship, now + 9 * 60_000) === undefined, true, 'the ship last heard 11 min ago');
  const consort = { ...vessel('consort', 21.01, -158, 90, 6), observedAt: own.observedAt };
  const together = cpa(
    { ...own, properties: { courseDegrees: 90, ownVessel: true }, motion: { speedMps: (6 * 1852) / 3600 } },
    consort,
    now,
  )!;
  assert.equal(together.holding, true);
  assert.match(cpaText(together), /0\.6 nm 000° N · range holding$/);
});
