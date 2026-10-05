import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkyOverheadAnswer, SkySatellite } from '@worldview/ipc-contract';
import { PLOT_RADIUS, lookText, polarXY, shownSatellites, skySummary, visibleToEye } from './sky-plot.js';

const sat = (id: string, elevationDeg: number, over: Partial<SkySatellite> = {}): SkySatellite => ({
  id,
  name: id,
  azimuthDeg: 47,
  elevationDeg,
  rangeM: 1_120_000,
  altitudeM: 420_000,
  sunlit: true,
  ...over,
});

test('the sky plot: the zenith in the middle, the horizon round the edge, north up and east right', () => {
  assert.deepEqual(polarXY(123, 90), { x: 0, y: 0 });
  assert.deepEqual(polarXY(0, 0), { x: 0, y: -PLOT_RADIUS });
  assert.deepEqual(polarXY(90, 0), { x: PLOT_RADIUS, y: 0 });
  assert.deepEqual(polarXY(180, 45), { x: 0, y: PLOT_RADIUS / 2 });
  assert.deepEqual(polarXY(270, -3), { x: -PLOT_RADIUS, y: 0 }, 'a little below the horizon: on its edge');
});

test('which could be seen: sunlit, ten degrees up, the Sun six below; the filters; the summary', () => {
  const answer: SkyOverheadAnswer = {
    at: '2026-10-05T12:00:00.000Z',
    observer: { latitude: 21.3, longitude: -157.85 },
    total: 4,
    sunElevationDeg: -40,
    satellites: [
      sat('ISS (ZARYA)', 62, { category: 'station' }),
      sat('STARLINK-1007', 40, { category: 'starlink' }),
      sat('NOAA 19', 30, { sunlit: false, category: 'weather' }),
      sat('LOW ONE', 5),
    ],
  };
  assert.equal(visibleToEye(answer.satellites[0]!, -40), true);
  assert.equal(visibleToEye(answer.satellites[0]!, -3), false, 'twilight: not dark enough');
  assert.equal(visibleToEye(answer.satellites[2]!, -40), false, "in the Earth's shadow");
  assert.equal(visibleToEye(answer.satellites[3]!, -40), false, 'too low');
  assert.deepEqual(
    shownSatellites(answer, { hideStarlink: true, onlyVisible: false }).map((s) => s.id),
    ['ISS (ZARYA)', 'NOAA 19', 'LOW ONE'],
  );
  assert.deepEqual(
    shownSatellites(answer, { hideStarlink: false, onlyVisible: true }).map((s) => s.id),
    ['ISS (ZARYA)', 'STARLINK-1007'],
  );
  assert.equal(skySummary(answer), '4 above the horizon · 2 could be seen (sunlit, 10° up or more)');
  assert.equal(
    skySummary({ ...answer, sunElevationDeg: 20 }),
    '4 above the horizon · the sky is not dark: none can be seen with the eye',
  );
  assert.equal(lookText(answer.satellites[0]!), '62° up · 047° NE · 1,120 km');
});
