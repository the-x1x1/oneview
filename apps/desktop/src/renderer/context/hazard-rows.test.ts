import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, WorldObject } from '@worldview/world-model';
import { cycloneWind, hazardRows, saffirSimpson } from './sections.js';

const alert = (properties: Record<string, JsonValue>) => ({ properties, labels: {} }) as unknown as WorldObject;
const shown = (o: WorldObject) => hazardRows(o).filter((r) => r.value !== undefined);

test('an NWS alert gains no rows: every hazard row needs its own key', () => {
  assert.deepEqual(shown(alert({ event: 'Flood Watch', severity: 'Moderate', areaDesc: 'Oahu' })), []);
});

test('a wildfire perimeter shows its burned area, containment and discovery', () => {
  assert.deepEqual(shown(alert({ areaAcres: 3459.2, percentContained: 0, onset: '2026-06-20T23:01:00.000Z' })), [
    { label: 'Burned area', value: '3,459.2 acres' },
    { label: 'Contained', value: '0%' },
    { label: 'Began', value: '2026-06-20 23:01:00 UTC' },
  ]);
});

test('a GDACS alert shows its level, and the episode level when it differs; an NHC cone its advisory', () => {
  assert.deepEqual(
    shown(alert({ alertLevel: 'Orange', episodeAlertLevel: 'Green', severityText: 'Magnitude 6.4M, Depth:24.3km' })),
    [
      { label: 'Alert level', value: 'Orange (this episode Green)' },
      { label: 'Impact', value: 'Magnitude 6.4M, Depth:24.3km' },
    ],
  );
  assert.deepEqual(shown(alert({ alertLevel: 'Red', episodeAlertLevel: 'Red' })), [
    { label: 'Alert level', value: 'Red' },
  ]);
  assert.deepEqual(shown(alert({ advisoryNumber: '30A', advisoryDate: '1100 PM MST Sun Sep 27 2026' })), [
    { label: 'Advisory', value: '30A · 1100 PM MST Sun Sep 27 2026' },
  ]);
});

test('a GDACS cyclone shows its maximum wind with the Saffir–Simpson equivalent', () => {
  assert.deepEqual(shown(alert({ maxWindKmh: 231.5 })), [
    { label: 'Maximum wind', value: '232 km/h (144 mph, 125 kt) · Category 4 equivalent' },
  ]);
  assert.deepEqual(shown(alert({ maxWindKmh: 74 })), [{ label: 'Maximum wind', value: '74 km/h (46 mph, 40 kt)' }]);
  assert.equal(cycloneWind(0), undefined);
  assert.equal(saffirSimpson(64), 1);
  assert.equal(saffirSimpson(63), undefined);
  assert.equal(saffirSimpson(137), 5);
});

test('an NWS tornado warning shows detection, damage threat, gusts and hail', () => {
  assert.deepEqual(
    shown(
      alert({
        tornadoDetection: 'OBSERVED',
        damageThreat: 'CONSIDERABLE',
        maxWindGust: '70 mph',
        maxHailSize: '1.75',
      }),
    ),
    [
      { label: 'Tornado', value: 'Observed' },
      { label: 'Damage threat', value: 'Considerable — a particularly dangerous situation' },
      { label: 'Wind gusts to', value: '70 mph' },
      { label: 'Hail up to', value: '1.75 in' },
    ],
  );
});

test('a storm report shows its type and size; an SPC area its risk level', () => {
  assert.deepEqual(
    shown(
      alert({ reportType: 'Hail', magnitude: '1.00', magnitudeUnits: 'Inch', reportedAt: '2026-09-27T23:30:00.000Z' }),
    ),
    [
      { label: 'Report', value: 'Hail' },
      { label: 'Magnitude', value: '1.00 in' },
      { label: 'Reported', value: '2026-09-27 23:30:00 UTC' },
    ],
  );
  assert.deepEqual(shown(alert({ reportType: 'Tstm Wnd Gst', magnitude: '55', magnitudeUnits: 'mph' }))[1], {
    label: 'Magnitude',
    value: '55 mph',
  });
  assert.deepEqual(shown(alert({ spcCategory: 'ENH' })), [{ label: 'Risk', value: 'Enhanced (3 of 5)' }]);
  assert.deepEqual(shown(alert({ spcCategory: 'TSTM' })), [
    { label: 'Risk', value: 'General thunderstorms (no severe risk)' },
  ]);
});
