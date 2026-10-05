import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import { EventEngine } from '../engine.js';
import {
  AIRCRAFT_EMERGENCY_QUIET_MS,
  AIRCRAFT_EMERGENCY_REOPEN_MS,
  aircraftEmergencyRule,
  emergencyOf,
} from './aircraft-emergency.js';

const T0 = Date.parse('2026-10-05T20:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function aircraft(id: string, props: Record<string, unknown>, sec: number, lat = 21.3): WorldObject {
  return {
    id: `aircraft:icao24:${id}`,
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
  // A status left from an earlier report (a report without one keeps it in the world) is
  // overruled by a squawk that says otherwise; one the pilot sets is not.
  assert.equal(emergencyOf(a({ squawk: '2345', emergency: 'general' })), undefined);
  assert.equal(emergencyOf(a({ squawk: '2345', emergency: 'nordo' })), undefined);
  assert.equal(emergencyOf(a({ emergency: 'general' })), 'general', 'no squawk to say otherwise');
  assert.equal(emergencyOf(a({ squawk: '2345', emergency: 'minfuel' })), 'minfuel');
});

test('7700: one event per episode, following the aircraft once a minute, ended when cleared', () => {
  const r = runner();
  const [raised] = r.step([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '7700', emergency: 'general' }, 0)], 0);
  assert.equal(raised!.id, `event:aircraft-emergency:icao24:a1b2c3-${T0 / 1000}`);
  assert.equal(raised!.title, 'UAL123: general emergency (squawk 7700)');
  assert.equal(raised!.severity, 'SEVERE');
  assert.deepEqual(raised!.objectIds, ['aircraft:icao24:a1b2c3']);
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

test('heard again saying it soon after going quiet, the same event goes on; a re-sent report is not heard', () => {
  const r = runner();
  const plane = (sec: number, squawk = '7700') => aircraft('a1b2c3', { callsign: 'UAL123', squawk }, sec);
  const [raised] = r.step([plane(0)], 0);
  // adsb.lol lists the same answer again: the report has not moved on, so it is not heard.
  const quiet = AIRCRAFT_EMERGENCY_QUIET_MS / 1000 + 30;
  const [ended] = r.step([plane(0)], quiet);
  assert.equal(ended!.endAt, at(0));
  assert.equal(ended!.properties?.['endReason'], 'quiet');
  // Its coverage comes round again a few minutes later: the same episode, open.
  const [resumed] = r.step([plane(quiet + 60)], quiet + 60);
  assert.equal(resumed!.id, raised!.id);
  assert.equal(resumed!.endAt, undefined);
  assert.equal(resumed!.startAt, raised!.startAt);
  // Cleared, then squawked again: a new episode (only quiet ones go on).
  r.step([plane(quiet + 120, '2345')], quiet + 120);
  const [fresh] = r.step([plane(quiet + 180)], quiet + 180);
  assert.notEqual(fresh!.id, raised!.id);
  // Quiet for longer than the reopening window: a new one too.
  const r2 = runner();
  const [first] = r2.step([plane(0)], 0);
  r2.step([], quiet);
  const late = (AIRCRAFT_EMERGENCY_REOPEN_MS + AIRCRAFT_EMERGENCY_QUIET_MS) / 1000 + 120;
  const [later] = r2.step([plane(late)], late);
  assert.notEqual(later!.id, first!.id);
});

test('the engine ends a quiet emergency on its own minute, with no aircraft reporting at all', () => {
  const clock = {
    t: T0,
    now() {
      return this.t;
    },
  };
  const engine = new EventEngine({ clock, rules: [aircraftEmergencyRule] });
  engine.ingestBatch([aircraft('a1b2c3', { callsign: 'UAL123', squawk: '7700' }, 0)]);
  assert.equal(engine.store.ofType('aircraft-emergency')[0]?.endAt, undefined);
  clock.t = T0 + AIRCRAFT_EMERGENCY_QUIET_MS + 60_000;
  engine.endQuiet();
  assert.equal(engine.store.ofType('aircraft-emergency')[0]?.endAt, at(0));
});
