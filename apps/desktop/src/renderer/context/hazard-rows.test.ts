import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, WorldObject } from '@worldview/world-model';
import { hazardRows } from './sections.js';

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
