import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay, WorldObject } from '@worldview/world-model';
import { themeEntry } from '@worldview/render-core';
import { weatherLegend } from './weather-legend.js';

const overlay = (providerId: string) => ({ id: `${providerId}:x`, providerId }) as unknown as RasterOverlay;
const alert = (properties: Record<string, string>) =>
  ({
    id: `weather-alert:p:${JSON.stringify(properties)}`,
    type: 'weather-alert',
    properties,
  }) as unknown as WorldObject;

test('weather legend: nothing when nothing weather is on the map', () => {
  assert.deepEqual(weatherLegend([overlay('gibs-goes-east-infrared')], []), []);
  assert.deepEqual(weatherLegend([], [alert({ severity: 'SEVERE' })]), [], 'a plain alert keeps its severity colour');
});

test('weather legend: radar and precipitation scales for their overlays; SPC, warnings and reports for their objects', () => {
  const sections = weatherLegend(
    [overlay('nowcoast-radar'), overlay('gibs-imerg-precipitation')],
    [
      alert({ spcCategory: 'SLGT' }),
      alert({ alertKind: 'tornado-warning' }),
      alert({ alertKind: 'flash-flood-warning' }),
      alert({ reportType: 'Hail' }),
      alert({ reportType: 'Funnel Cloud' }),
    ],
  );
  assert.deepEqual(
    sections.map((s) => s.id),
    ['radar', 'precipitation', 'spc', 'warnings', 'reports'],
  );
  const radar = sections[0]!;
  assert.equal(radar.ramp!.length, 15, '5 to 75 dBZ in steps of 5');
  assert.deepEqual(
    radar.ramp!.filter((s) => s.label).map((s) => s.label),
    ['5', '20', '35', '50', '65', '75'],
  );
  assert.match(sections[1]!.note!, /4 h/);
  // The chips are the map's own colours, the warnings in order of urgency and only those present.
  const warnings = sections.find((s) => s.id === 'warnings')!;
  assert.deepEqual(
    warnings.chips!.map((c) => c.label),
    ['Tornado warning', 'Flash flood'],
  );
  assert.equal(warnings.chips![0]!.color, themeEntry('weather-alert.tornado-warning').color);
  const spc = sections.find((s) => s.id === 'spc')!;
  assert.equal(spc.chips!.length, 6, 'the whole scale, so a slight risk reads against it');
  assert.equal(spc.chips![2]!.color, themeEntry('weather-alert.spc-slgt').color);
  assert.deepEqual(
    sections.find((s) => s.id === 'reports')!.chips!.map((c) => c.label),
    ['Tornado', 'Hail'],
  );
});
