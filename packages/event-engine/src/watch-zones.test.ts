import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchZone } from '@worldview/ipc-contract';
import { WatchZoneEvaluator, inQuietHours, mayInterrupt } from './watch-zones.js';
import { DAY, FixedClock, HOUR, T0, eventFrom, iso, obj } from './test-fixtures.js';

const oahuCircle: WatchZone = {
  id: 'wz-oahu',
  name: 'Oahu',
  geometry: { kind: 'circle', center: { latitude: 21.44, longitude: -158.0 }, radiusM: 60_000 },
  eventTypes: ['earthquake', 'weather-alert', 'wildfire-cluster'],
  minimumSeverity: 'MODERATE',
  notifications: { inApp: true, desktop: true },
  enabled: true,
  createdAt: iso(-DAY),
};
const japanPolygon: WatchZone = {
  id: 'wz-japan',
  name: 'Japan',
  geometry: {
    kind: 'polygon',
    polygon: [
      [129, 31],
      [146, 31],
      [146, 45],
      [129, 45],
      [129, 31],
    ],
  },
  eventTypes: [],
  notifications: { inApp: true, desktop: false },
  enabled: true,
  createdAt: iso(-DAY),
};
const trafficBounds: WatchZone = {
  id: 'wz-hnl',
  name: 'HNL approach',
  geometry: { kind: 'bounds', bounds: { west: -158.1, south: 21.2, east: -157.7, north: 21.5 } },
  eventTypes: ['watch-zone-entry'],
  notifications: { inApp: true, desktop: false },
  enabled: true,
  createdAt: iso(-DAY),
};

test('WatchZoneEvaluator: circle + polygon intersection, severity gate, enter once, 6 h dedupe', () => {
  const clock = new FixedClock();
  const ev = new WatchZoneEvaluator({ clock });
  ev.setZones([oahuCircle, japanPolygon]);
  const hits: string[] = [];
  ev.on('hit', (h) => hits.push(`${h.zone.id}:${h.subjectId}`));

  const quakeOahu = eventFrom({
    id: 'event:earthquake:usgs:o1',
    type: 'earthquake',
    title: 'M5.0 earthquake — Oahu',
    startAt: iso(-HOUR),
    severity: 'MODERATE',
    geometry: { type: 'Point', coordinates: [-157.9, 21.4] },
    objectIds: ['earthquake:usgs:o1'],
    summary: 'Magnitude 5.0.',
  });
  const first = ev.evaluateEvent(quakeOahu);
  assert.equal(first.length, 1);
  const hit = first[0]!;
  assert.equal(hit.zone.id, 'wz-oahu');
  assert.equal(hit.subjectKind, 'event');
  assert.equal(hit.event.type, 'watch-zone-entry');
  assert.equal(hit.event.id, `event:watch-zone-entry:wz-oahu:event:earthquake:usgs:o1@${Math.floor(T0 / 1000)}`);
  assert.equal(hit.event.title, 'Oahu: M5.0 earthquake — Oahu');
  assert.equal(hit.event.severity, 'MODERATE');
  assert.deepEqual(hit.event.objectIds, ['earthquake:usgs:o1']);
  assert.equal(hit.event.properties!['watchZoneId'], 'wz-oahu');
  assert.deepEqual(hit.notification, {
    id: hit.event.id,
    title: 'Oahu: M5.0 earthquake — Oahu',
    body: 'M5.0 earthquake — Oahu intersects watch zone "Oahu".',
    severity: 'MODERATE',
    eventId: 'event:earthquake:usgs:o1',
    watchZoneId: 'wz-oahu',
  });

  assert.equal(ev.evaluateEvent(quakeOahu).length, 0, 'same subject again → deduped');
  clock.advance(5 * HOUR);
  assert.equal(ev.evaluateEvent({ ...quakeOahu, title: 'updated' }).length, 0, 'still inside the 6 h window');
  clock.advance(HOUR + 1);
  assert.equal(ev.evaluateEvent(quakeOahu).length, 1, 'after the window a new entry may fire');

  const weak = eventFrom({
    id: 'event:earthquake:usgs:o2',
    type: 'earthquake',
    startAt: iso(0),
    severity: 'MINOR',
    geometry: { type: 'Point', coordinates: [-157.9, 21.4] },
  });
  assert.equal(ev.evaluateEvent(weak).length, 0, 'below minimumSeverity');
  const wrongType = eventFrom({
    id: 'event:launch:x:1',
    type: 'launch',
    startAt: iso(0),
    severity: 'EXTREME',
    geometry: { type: 'Point', coordinates: [-157.9, 21.4] },
  });
  assert.equal(ev.evaluateEvent(wrongType).length, 0, 'event type not subscribed by the circle zone');
  const outside = eventFrom({
    id: 'event:earthquake:usgs:o3',
    type: 'earthquake',
    startAt: iso(0),
    severity: 'EXTREME',
    geometry: { type: 'Point', coordinates: [-155.3, 19.4] },
  });
  assert.equal(ev.evaluateEvent(outside).length, 0, 'Big Island is outside the Oahu circle');

  const japanQuake = eventFrom({
    id: 'event:earthquake:usgs:j1',
    type: 'earthquake',
    startAt: iso(0),
    severity: 'INFO',
    geometry: { type: 'Point', coordinates: [140, 36] },
  });
  const jp = ev.evaluateEvent(japanQuake);
  assert.equal(jp.length, 1, 'polygon zone with no eventTypes/minimum accepts everything');
  assert.equal(jp[0]!.zone.id, 'wz-japan');
  const alert = eventFrom({
    id: 'event:weather-alert:jma:1',
    type: 'weather-alert',
    startAt: iso(0),
    severity: 'SEVERE',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [135, 33],
          [137, 33],
          [137, 35],
          [135, 35],
          [135, 33],
        ],
      ],
    },
  });
  assert.equal(ev.evaluateEvent(alert)[0]!.zone.id, 'wz-japan', 'polygon geometry vs polygon zone');
  const noGeometry = eventFrom({
    id: 'event:source-status-change:x:1',
    type: 'source-status-change',
    startAt: iso(0),
    severity: 'INFO',
  });
  assert.equal(ev.evaluateEvent(noGeometry).length, 0);
  const entry = eventFrom({
    id: 'event:watch-zone-entry:wz-japan:x',
    type: 'watch-zone-entry',
    startAt: iso(0),
    severity: 'SEVERE',
    geometry: { type: 'Point', coordinates: [140, 36] },
  });
  assert.equal(ev.evaluateEvent(entry).length, 0, 'entry events never re-trigger zones');
  assert.equal(hits.length, 4);

  ev.setZones([{ ...oahuCircle, enabled: false }]);
  assert.equal(
    ev.evaluateEvent({ ...quakeOahu, id: 'event:earthquake:usgs:o9' }).length,
    0,
    'disabled zones are skipped',
  );
});

test('WatchZoneEvaluator: aircraft/vessel entries fire on outside→inside transitions only', () => {
  const clock = new FixedClock();
  const ev = new WatchZoneEvaluator({ clock });
  ev.setZones([trafficBounds, oahuCircle]);
  const plane = (lat: number, lon: number, at = iso(0)) =>
    obj({
      id: 'aircraft:icao24:a1b2c3',
      type: 'aircraft',
      providerId: 'adsb-lol',
      observedAt: at,
      lat,
      lon,
      altitudeM: 900,
      labels: { callsign: 'HAL45' },
    });
  assert.equal(ev.evaluateObjects([plane(21.0, -158.0)]).length, 0, 'outside');
  const enter = ev.evaluateObjects([plane(21.3, -157.9)]);
  assert.equal(enter.length, 1, 'only the zone subscribed to watch-zone-entry fires');
  assert.equal(enter[0]!.zone.id, 'wz-hnl');
  assert.equal(enter[0]!.subjectKind, 'object');
  assert.equal(enter[0]!.event.title, 'HNL approach: aircraft HAL45 entered');
  assert.equal(enter[0]!.event.severity, 'MINOR');
  assert.deepEqual(enter[0]!.event.objectIds, ['aircraft:icao24:a1b2c3']);
  assert.deepEqual(enter[0]!.event.geometry, { type: 'Point', coordinates: [-157.9, 21.3, 900] });
  assert.equal(enter[0]!.notification.eventId, enter[0]!.event.id);
  assert.equal(enter[0]!.notification.watchZoneId, 'wz-hnl');
  assert.equal(ev.evaluateObjects([plane(21.35, -157.95)]).length, 0, 'still inside → no repeat');
  assert.equal(ev.evaluateObjects([plane(21.0, -158.0)]).length, 0, 'left');
  assert.equal(
    ev.evaluateObjects([plane(21.3, -157.9)]).length,
    0,
    're-entry inside the 6 h dedupe window is suppressed',
  );
  clock.advance(7 * HOUR);
  assert.equal(ev.evaluateObjects([plane(21.0, -158.0)]).length, 0);
  assert.equal(ev.evaluateObjects([plane(21.3, -157.9)]).length, 1, 're-entry after the window fires again');
  const ship = obj({
    id: 'vessel:mmsi:366123456',
    type: 'vessel',
    lat: 21.3,
    lon: -157.87,
    labels: { name: 'Aloha Star' },
  });
  const camera = obj({ id: 'camera:cctv:1', type: 'camera', lat: 21.3, lon: -157.87 });
  const res = ev.evaluateObjects([ship, camera]);
  assert.equal(res.length, 1, 'vessels count, cameras do not');
  assert.equal(res[0]!.event.title, 'HNL approach: vessel Aloha Star entered');
  ev.forgetObject('vessel:mmsi:366123456');
  clock.advance(7 * HOUR);
  assert.equal(ev.evaluateObjects([ship]).length, 1, 'forgotten object counts as a fresh entry');
  ev.setZones([{ ...trafficBounds, minimumSeverity: 'MODERATE' }]);
  clock.advance(7 * HOUR);
  assert.equal(
    ev.evaluateObjects([obj({ id: 'aircraft:icao24:ffffff', type: 'aircraft', lat: 21.3, lon: -157.9 })]).length,
    0,
    'MINOR entries are gated by minimumSeverity',
  );
});

test('quiet hours: a span in the day, one across midnight, and SEVERE still getting through', () => {
  const zone = (quietHours?: { start: string; end: string }): WatchZone => ({
    id: 'z',
    name: 'Z',
    geometry: { kind: 'circle', center: { latitude: 0, longitude: 0 }, radiusM: 1 },
    eventTypes: ['earthquake'],
    notifications: { inApp: true, desktop: true },
    enabled: true,
    createdAt: '2026-09-21T00:00:00.000Z',
    ...(quietHours ? { quietHours } : {}),
  });
  const at = (hh: number, mm = 0) => hh * 60 + mm;
  assert.equal(inQuietHours({ start: '12:00', end: '14:00' }, at(13)), true);
  assert.equal(inQuietHours({ start: '12:00', end: '14:00' }, at(14)), false, 'the end is not inside');
  assert.equal(inQuietHours({ start: '22:00', end: '07:00' }, at(23, 30)), true, 'across midnight');
  assert.equal(inQuietHours({ start: '22:00', end: '07:00' }, at(6, 59)), true);
  assert.equal(inQuietHours({ start: '22:00', end: '07:00' }, at(12)), false);
  assert.equal(inQuietHours({ start: 'bad', end: '07:00' }, at(1)), false);
  assert.equal(inQuietHours(undefined, at(1)), false);
  const night = zone({ start: '22:00', end: '07:00' });
  assert.equal(mayInterrupt(night, 'MODERATE', at(2)), false);
  assert.equal(mayInterrupt(night, 'SEVERE', at(2)), true, 'severe events still interrupt');
  assert.equal(mayInterrupt(night, 'MINOR', at(9)), true, 'outside quiet hours everything does');
  assert.equal(mayInterrupt(zone(), 'INFO', at(2)), true);
});
