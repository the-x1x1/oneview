import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, WorldObject } from '@worldview/world-model';
import { OVERVIEW_LAYERS, lensFilter } from './overview-layers.js';
import { BUILT_IN_LENSES } from '@worldview/render-core';
import { severityRank, stormsTarget, stormsViewHidden } from './storms-view.js';

const obj = (
  id: string,
  type: string,
  properties: Record<string, JsonValue>,
  observedAt = '2026-09-28T20:00:00.000Z',
) =>
  ({
    id,
    type,
    properties,
    labels: {},
    observedAt,
    position: { latitude: 20, longitude: -100 },
  }) as unknown as WorldObject;

test('storms view: only Weather and Disasters on, their own types back on, the rest of the list kept', () => {
  const hidden = stormsViewHidden(['weather', 'type.storm', 'type.airport', 'aircraft.military-only']);
  const others = OVERVIEW_LAYERS.map((l) => l.id).filter((id) => id !== 'weather' && id !== 'disasters');
  assert.deepEqual(hidden.sort(), ['aircraft.military-only', 'type.airport', ...others].sort());
  const overview = BUILT_IN_LENSES.find((l) => l.id === 'overview')!;
  const shown = lensFilter(overview, hidden).objectTypes;
  for (const t of ['storm', 'weather-alert', 'earthquake', 'fire-detection']) assert.ok(shown.has(t), t);
  assert.ok(!shown.has('aircraft') && !shown.has('vessel') && !shown.has('satellite'));
});

test('storms view target: a Category 3+ cyclone first, the strongest, NHC before GDACS at the same wind', () => {
  const t = stormsTarget([
    obj('weather-alert:weather:tor', 'weather-alert', { alertKind: 'tornado-emergency', severity: 'EXTREME' }),
    obj('storm:nhc-storms:ep172026', 'storm', { name: 'Polo', intensityKt: 100 }),
    obj('storm:nhc-storms:ep152026', 'storm', { name: 'Nolo', intensityKt: 125 }),
    obj('weather-alert:gdacs-tropical-cyclones:1', 'weather-alert', { gdacsEventType: 'TC', maxWindKmh: 231.5 }),
  ]);
  assert.equal(t?.reason, 'major-cyclone');
  assert.equal(t?.object.id, 'storm:nhc-storms:ep152026', '125 kt, and NHC’s own over GDACS’s 125 kt equivalent');
});

test('storms view target: no major cyclone, so the most urgent tornado warning, then the newest', () => {
  const t = stormsTarget([
    obj('storm:nhc-storms:al082026', 'storm', { name: 'Hanna', intensityKt: 45 }),
    obj('storm:nhc-storms:ep182026', 'storm', { name: 'Rachel', intensityKt: 90 }),
    obj('weather-alert:weather:a', 'weather-alert', { alertKind: 'tornado-warning' }, '2026-09-28T21:00:00.000Z'),
    obj('weather-alert:weather:b', 'weather-alert', { alertKind: 'tornado-pds' }, '2026-09-28T19:00:00.000Z'),
    obj('weather-alert:weather:c', 'weather-alert', { alertKind: 'tornado-watch', severity: 'EXTREME' }),
  ]);
  assert.deepEqual([t?.reason, t?.object.id], ['tornado-warning', 'weather-alert:weather:b']);
  const newest = stormsTarget([
    obj('weather-alert:weather:a', 'weather-alert', { alertKind: 'tornado-warning' }, '2026-09-28T19:00:00.000Z'),
    obj('weather-alert:weather:d', 'weather-alert', { alertKind: 'tornado-warning' }, '2026-09-28T21:00:00.000Z'),
  ]);
  assert.equal(newest?.object.id, 'weather-alert:weather:d');
});

test('storms view target: else the highest severity alert; a hurricane below Cat 3 counts as severe', () => {
  const t = stormsTarget([
    obj('weather-alert:weather:frost', 'weather-alert', { severity: 'MINOR' }),
    obj('weather-alert:weather:wind', 'weather-alert', { severity: 'EXTREME' }),
    obj('storm:nhc-storms:ep182026', 'storm', { name: 'Rachel', intensityKt: 90 }),
    // Forecast positions, past track and the wind field are not candidates.
    obj('weather-alert:nhc-forecast-points:1', 'weather-alert', { cycloneLayer: 'forecast-point', intensityKt: 130 }),
  ]);
  assert.deepEqual([t?.reason, t?.object.id], ['alert', 'weather-alert:weather:wind']);
  assert.equal(
    stormsTarget([
      obj('storm:nhc-storms:ep182026', 'storm', { intensityKt: 90 }),
      obj('weather-alert:w:x', 'weather-alert', { severity: 'MODERATE' }),
    ])?.object.id,
    'storm:nhc-storms:ep182026',
  );
  // A GDACS red alert (score 3) is SEVERE; nothing with a severity is nothing.
  assert.equal(severityRank(3), 3);
  assert.equal(severityRank('Severe'), 3);
  assert.equal(stormsTarget([obj('weather-alert:x:y', 'weather-alert', { spcCategory: 'SLGT' })]), undefined);
  assert.equal(stormsTarget([]), undefined);
});
