import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import {
  DARK_THEME,
  SATELLITE_CATEGORY_SUFFIXES,
  presentObjects,
  splitAtAntimeridian,
  themeEntry,
  trailFeatures,
  type ViewState,
} from './index.js';

function obj(id: string, type: string, props: WorldObject['properties'], heading?: number): WorldObject {
  const o: WorldObject = {
    id,
    type,
    sourceRefs: [{ observationId: id, providerId: 'p', observedAt: '2026-09-27T00:00:00.000Z' }],
    position: { latitude: 20, longitude: -157 },
    observedAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    freshness: 'LIVE',
    confidence: 0.9,
    labels: {},
    properties: props,
    provenance: { providerId: 'p', sourceName: 'p', origin: 'live', receivedAt: '2026-09-27T00:00:00.000Z' },
  };
  if (heading !== undefined) o.motion = { headingDegrees: heading };
  return o;
}

const local: ViewState = {
  center: { latitude: 20, longitude: -157 },
  altitudeM: 5000,
  zoom: 13,
  headingDegrees: 0,
  pitchDegrees: -90,
  bounds: { west: -158, south: 19, east: -156, north: 21 },
};
const globalView: ViewState = {
  ...local,
  zoom: 1,
  altitudeM: 20_000_000,
  bounds: { west: -180, south: -85, east: 180, north: 85 },
};

test('aircraft: a silhouette per class, rotated by track (a balloon is not); military in its own colour', () => {
  const objects = [
    obj('aircraft:icao24:000001', 'aircraft', { typeCode: 'B77W', military: false }, 90),
    obj('aircraft:icao24:000002', 'aircraft', { category: 'A7', military: true }, 45),
    obj('aircraft:icao24:000003', 'aircraft', { category: 'B2' }, 200),
    obj('aircraft:icao24:000004', 'aircraft', {}, 10),
  ];
  const out = presentObjects({ objects, view: local });
  const f = (n: string) => out.upsert.find((x) => x.objectId === `aircraft:icao24:00000${n}`)!;
  assert.equal(f('1').style.icon, 'aircraft-heavy');
  assert.equal(f('1').style.rotationDegrees, 90);
  assert.equal(f('1').style.styleClass, 'aircraft');
  assert.equal(f('2').style.icon, 'helicopter');
  assert.equal(f('2').style.styleClass, 'aircraft.military');
  assert.equal(f('3').style.icon, 'balloon');
  assert.equal(f('3').style.rotationDegrees, undefined, 'a balloon has no nose');
  assert.equal(f('4').style.icon, 'aircraft', 'unknown: the generic jet, as before');
  // Zoomed out, points: no icon, but the military colour holds.
  const far = presentObjects({ objects, view: globalView });
  const mil = far.upsert.find((x) => x.objectId === 'aircraft:icao24:000002')!;
  assert.equal(mil.style.icon, undefined);
  assert.equal(mil.style.styleClass, 'aircraft.military');
  assert.notEqual(themeEntry('aircraft.military').color, themeEntry('aircraft').color);
});

test('satellites: coloured by category; an unlisted or odd value keeps the plain class', () => {
  const objects = [
    obj('satellite:norad:1', 'satellite', { satelliteCategory: 'station' }),
    obj('satellite:norad:2', 'satellite', { satelliteCategory: 'starlink' }),
    obj('satellite:norad:3', 'satellite', { satelliteCategory: 'rocket-body' }),
    obj('satellite:norad:4', 'satellite', { satelliteCategory: 'other' }),
    obj('satellite:norad:5', 'satellite', { satelliteCategory: 'constructor' }),
    obj('satellite:norad:6', 'satellite', {}),
  ];
  const out = presentObjects({ objects, view: globalView });
  const cls = (n: number) => out.upsert.find((x) => x.objectId === `satellite:norad:${n}`)!.style.styleClass;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(cls), [
    'satellite.station',
    'satellite.starlink',
    'satellite.debris',
    'satellite',
    'satellite',
    'satellite',
  ]);
});

test('theme: every satellite category suffix has its own entry, and they are told apart', () => {
  const colours = new Set<string>();
  for (const suffix of new Set(Object.values(SATELLITE_CATEGORY_SUFFIXES))) {
    const key = `satellite.${suffix}`;
    assert.ok(DARK_THEME.entries[key], key);
    colours.add(DARK_THEME.entries[key]!.color);
  }
  assert.equal(colours.size, new Set(Object.values(SATELLITE_CATEGORY_SUFFIXES)).size);
  assert.ok(DARK_THEME.entries['trail.predicted']);
});

test('trail: observed points one trail, predicted ones a dashed line from the last observed point', () => {
  const features = trailFeatures('satellite:norad:1', [
    { latitude: 0, longitude: 10 },
    { latitude: 1, longitude: 11 },
    { latitude: 2, longitude: 12, predicted: true },
    { latitude: 3, longitude: 13, predicted: true },
  ]);
  assert.deepEqual(
    features.map((f) => [
      f.id,
      f.style.styleClass,
      f.style.lineStyle,
      f.geometry.kind === 'line' ? f.geometry.positions.length : 0,
    ]),
    [
      ['trail:satellite:norad:1', 'trail', 'trail', 2],
      ['trail:satellite:norad:1:predicted', 'trail.predicted', 'dashed', 3],
    ],
  );
  // Through presentObjects, with the selection.
  const out = presentObjects({
    objects: [obj('satellite:norad:1', 'satellite', {})],
    view: local,
    selectedId: 'satellite:norad:1',
    selectedTrack: [
      { latitude: 0, longitude: 10 },
      { latitude: 1, longitude: 11, predicted: true },
    ],
  });
  assert.ok(out.upsert.some((f) => f.id === 'trail:satellite:norad:1:predicted'));
});

test('splitAtAntimeridian: a crossing ends one piece on ±180 and starts the next there, interpolated', () => {
  const pieces = splitAtAntimeridian([
    { latitude: 0, longitude: 170, altitudeM: 400_000 },
    { latitude: 10, longitude: 178, altitudeM: 400_000 },
    { latitude: 20, longitude: -178, altitudeM: 410_000 },
    { latitude: 30, longitude: -170, altitudeM: 410_000 },
  ]);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0]!.at(-1), { latitude: 15, longitude: 180, altitudeM: 405_000 });
  assert.deepEqual(pieces[1]![0], { latitude: 15, longitude: -180, altitudeM: 405_000 });
  assert.equal(pieces[1]!.length, 3);
  // Westward, and no crossing at all.
  const west = splitAtAntimeridian([
    { latitude: 0, longitude: -179 },
    { latitude: 0, longitude: 179 },
  ]);
  assert.deepEqual(
    west.map((p) => p.map((q) => q.longitude)),
    [
      [-179, -180],
      [180, 179],
    ],
  );
  assert.equal(
    splitAtAntimeridian([
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 90 },
    ]).length,
    1,
  );
  // Every piece stays within ±180 (Cesium refuses anything else).
  for (const p of pieces.flat()) assert.ok(Math.abs(p.longitude) <= 180);
});
