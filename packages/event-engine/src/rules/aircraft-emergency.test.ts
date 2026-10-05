import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import { AIRCRAFT_EMERGENCY_QUIET_MS, aircraftEmergencyRule, emergencyOf } from './aircraft-emergency.js';

const T0 = Date.parse('2026-10-05T20:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function aircraft(id: string, props: Record<string, unknown>, sec: number, lat = 21.3): WorldObject {
  return {
    id: `aircraft:icao:${id}`,
    type: 'aircraft',
    labels: props['callsign'] ? { callsign: props['callsign'] } : {},
    position: { latitude: lat, longitude: -157.9, altitudeM: 3000 },
    observedAt: at(sec),
    properties: { icao24: id, ...props },
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [{ providerId: 'adsb-lol', observationId: `o${sec}` }],
    provenance: { providerId: 'adsb-lol', sourceName: 'adsb.lol', origin: 'live', receivedAt: at(sec) },
  } as unknown as WorldObject;
}

function runner() {
  const store = new Map<string, WorldEvent>();
  return {
    store,
    step(objects: WorldObject[], sec: number): WorldEvent[] {
      const out = aircraftEmergencyRule.evaluate(objects, {
        now: T0 + sec * 1000,
        nowIso: at(sec),
        existing: () => [...store.values()],
      });
      for (const e of out) store.set(e.id, e);
      return out;
    },
  };
}

test('what an aircraft broadcasts: the squawk codes and the ADS-B status, the most serious named', () => {
  const a = (p: Record<string, unknown>) => aircraft('a1b2c3', p, 0);
  assert.equal(emergencyOf(a({ squawk: '7700' })), 'general');
  assert.equal(emergencyOf(a({ squawk: '7600' })), 'nordo');
  assert.equal(emergencyOf(a({ squawk: '7500' })), 'unlawful');
  assert.equal(emergencyOf(a({ emergency: 'minfuel' })), 'minfuel');
  assert.equal(emergencyOf(a({ emergency: 'downed' })), 'downed');
  assert.equal(emergencyOf(a({ squawk: '7600', emergency: 'general' })), 'general', 'the more serious');
  assert.equal(emergencyOf(a({ squawk: '1200', emergency: 'none' })), undefined);
  assert.equal(emergencyOf(a({ emergency: 'lifeguard' })), undefined, "a medical flight's priority is not one");
  assert.equal(emergencyOf(a({ emergency: 'reserved' })), undefined);
  assert.equal(emergencyOf(a({ emergency: 'constructor' })), undefined, 'not an inherited property name');
});

test('7700: one event per episode, following the aircraft once a minute, ended when cleared', () => {
  const r = runner();
  const [raised] = r.step([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '7700', emergency: 'general' }, 0)], 0);
  assert.equal(raised!.id, `event:aircraft-emergency:icao:a1b2c3-${T0 / 1000}`);
  assert.equal(raised!.title, 'UAL123: general emergency (squawk 7700)');
  assert.equal(raised!.severity, 'SEVERE');
  assert.deepEqual(raised!.objectIds, ['aircraft:icao:a1b2c3']);
  assert.match(raised!.summary, /As broadcast/);
  assert.deepEqual(
    r.step([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '7700' }, 20, 21.35)], 20),
    [],
    'twenty seconds on: nothing new to say',
  );
  const [followed] = r.step([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '7700' }, 70, 21.4)], 70);
  assert.equal(followed!.id, raised!.id);
  assert.deepEqual(followed!.geometry, { type: 'Point', coordinates: [-157.9, 21.4] });
  assert.equal(followed!.startAt, raised!.startAt);
  const [cleared] = r.step([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '2345' }, 90)], 90);
  assert.equal(cleared!.id, raised!.id);
  assert.equal(cleared!.endAt, at(90));
  assert.match(cleared!.summary, /Cleared at 2026-10-05 20:01 UTC\.$/);
  // Squawked again later: a new episode.
  const [again] = r.step([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '7700' }, 600)], 600);
  assert.notEqual(again!.id, raised!.id);
  assert.equal(again!.endAt, undefined);
});

test('a change of what it broadcasts is said at once; an aircraft not heard for ten minutes ends it', () => {
  const r = runner();
  const [raised] = r.step([aircraft('abc123', { registration: 'N12345', squawk: '7600' }, 0)], 0);
  assert.equal(raised!.title, 'N12345: radio failure (squawk 7600)');
  assert.equal(raised!.severity, 'MODERATE');
  const [worse] = r.step([aircraft('abc123', { registration: 'N12345', squawk: '7700' }, 10)], 10);
  assert.equal(worse!.title, 'N12345: general emergency (squawk 7700)');
  assert.equal(worse!.severity, 'SEVERE');
  assert.equal(worse!.id, raised!.id);
  // Other aircraft keep reporting; this one has gone quiet.
  const other = (sec: number) => aircraft('ffffff', { callsign: 'OTHER1', squawk: '1200' }, sec);
  assert.deepEqual(r.step([other(300)], 300), [], 'five minutes quiet: still open');
  const [quiet] = r.step(
    [other(10 + AIRCRAFT_EMERGENCY_QUIET_MS / 1000 + 5)],
    10 + AIRCRAFT_EMERGENCY_QUIET_MS / 1000 + 5,
  );
  assert.equal(quiet!.id, raised!.id);
  assert.equal(quiet!.endAt, at(10), 'ended when it was last heard');
  assert.match(quiet!.summary, /No longer heard after 2026-10-05 20:00 UTC\.$/);
});

test('minimum fuel without a squawk; no name falls back to the ICAO address; no position, no event', () => {
  const r = runner();
  const [e] = r.step([aircraft('a0b1c2', { emergency: 'minfuel' }, 0)], 0);
  assert.equal(e!.title, 'A0B1C2: minimum fuel');
  assert.equal(e!.severity, 'MODERATE');
  const noPosition = { ...aircraft('dddddd', { squawk: '7700' }, 0) };
  delete (noPosition as { position?: unknown }).position;
  assert.deepEqual(runner().step([noPosition], 0), []);
});
