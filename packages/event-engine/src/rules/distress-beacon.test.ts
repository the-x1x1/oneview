import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import { DISTRESS_BEACON_QUIET_MS, beaconKindOf, distressBeaconRule } from './distress-beacon.js';

const T0 = Date.parse('2026-10-05T21:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function station(mmsi: string, props: Record<string, unknown>, sec: number, lat = 59.4): WorldObject {
  return {
    id: `vessel:mmsi:${mmsi}`,
    type: 'vessel',
    labels: {},
    position: { latitude: lat, longitude: 24.7 },
    observedAt: at(sec),
    properties: { mmsi, ...props },
    confidence: 0.8,
    freshness: 'LIVE',
    sourceRefs: [{ providerId: 'ais-local', observationId: `o${sec}` }],
    provenance: { providerId: 'ais-local', sourceName: 'AIS receiver', origin: 'local', receivedAt: at(sec) },
  } as unknown as WorldObject;
}

function runner() {
  const store = new Map<string, WorldEvent>();
  return {
    step(objects: WorldObject[], sec: number): WorldEvent[] {
      const out = distressBeaconRule.evaluate(objects, {
        now: T0 + sec * 1000,
        nowIso: at(sec),
        existing: () => [...store.values()],
      });
      for (const e of out) store.set(e.id, e);
      return out;
    },
  };
}

test('the beacon kinds from the MMSI; ships, buoys and short numbers are none', () => {
  assert.equal(beaconKindOf('970123456'), 'sart');
  assert.equal(beaconKindOf('972111222'), 'mob');
  assert.equal(beaconKindOf('974000001'), 'epirb');
  assert.equal(beaconKindOf('366123456'), undefined);
  assert.equal(beaconKindOf('992761234'), undefined, 'an aid to navigation');
  assert.equal(beaconKindOf('97212345'), undefined);
  assert.equal(beaconKindOf(undefined), undefined);
});

test('a man-overboard beacon transmitting as active: SEVERE, followed as it drifts, ended when it stops', () => {
  const r = runner();
  const [raised] = r.step([station('972111222', { navStatus: 14 }, 0)], 0);
  assert.equal(raised!.id, `event:distress-beacon:mmsi:972111222-${T0 / 1000}`);
  assert.equal(raised!.title, 'Man overboard: 972111222');
  assert.equal(raised!.severity, 'SEVERE');
  assert.match(raised!.summary, /^A man-overboard beacon \(AIS MOB\), MMSI 972111222, has been transmitting as active/);
  assert.match(raised!.summary, /the coastguard is not told by this app\.$/);
  assert.deepEqual(r.step([station('972111222', { navStatus: 14 }, 30, 59.401)], 30), [], 'within the minute');
  const [drifted] = r.step([station('972111222', { navStatus: 14 }, 60, 59.402)], 60);
  assert.deepEqual(drifted!.geometry, { type: 'Point', coordinates: [24.7, 59.402] });
  const [stopped] = r.step([station('972111222', { navStatus: 15 }, 120)], 120);
  assert.equal(stopped!.endAt, at(120));
  assert.match(stopped!.summary, /No longer transmitting as active at 2026-10-05 21:02 UTC\.$/);
});

test('test transmissions, reports without a status and ordinary ships raise nothing', () => {
  const r = runner();
  assert.deepEqual(r.step([station('970123456', { navStatus: 15 }, 0)], 0), [], 'a SART test');
  assert.deepEqual(r.step([station('974000001', {}, 0)], 0), [], 'no status given');
  assert.deepEqual(r.step([station('366123456', { navStatus: 14 }, 0)], 0), [], 'a ship, whatever its status');
});

test('a SART not heard for ten minutes is ended when last heard; its name is given when sent', () => {
  const r = runner();
  const [raised] = r.step([station('970123456', { navStatus: 14, name: 'SART TEST VESSEL' }, 0)], 0);
  assert.equal(raised!.title, 'AIS-SART active: 970123456 (SART TEST VESSEL)');
  const ship = (sec: number) => station('366123456', { navStatus: 0 }, sec);
  assert.deepEqual(r.step([ship(300)], 300), []);
  const late = DISTRESS_BEACON_QUIET_MS / 1000 + 5;
  const [quiet] = r.step([ship(late)], late);
  assert.equal(quiet!.id, raised!.id);
  assert.equal(quiet!.endAt, at(0));
});
