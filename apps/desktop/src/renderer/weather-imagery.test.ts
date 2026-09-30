import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleOverlays,
  weatherImageryAllowed,
  weatherImageryFor,
  weatherImageryOn,
  withWeatherImagery,
} from './weather-imagery.js';
import { LAYER_GROUPS } from './layer-tree.js';

const o = (providerId: string, extra: { featherDeg?: number; role?: 'basemap' } = {}) => ({ providerId, ...extra });
const shipped = [
  o('gibs-goes-east-infrared', { featherDeg: 5 }),
  o('eumetsat-meteosat-infrared', { featherDeg: 5 }),
  o('gibs-imerg-precipitation'),
  o('nowcoast-radar'),
  o('nowcoast-strike-density'),
  o('gibs-viirs-snpp-true-colour'),
  o('gibs-viirs-noaa20-true-colour'),
  o('usgs-topo', { role: 'basemap' }),
];
const overview = { id: 'overview', objectTypes: ['aircraft', 'storm'] };
const aviation = { id: 'aviation', objectTypes: ['aircraft', 'airport'] };
const weatherLens = { id: 'weather', objectTypes: ['weather-alert', 'storm'] };
const ids = (hidden: string[], lens = overview, choices = {}) =>
  visibleOverlays(shipped, lens, hidden, choices).map((x) => x.providerId);

test('each shipped weather overlay answers to one switch; other imagery to none', () => {
  assert.deepEqual(
    shipped.map((x) => weatherImageryFor(x)?.id),
    [
      'imagery.infrared',
      'imagery.infrared',
      'imagery.precipitation',
      'imagery.radar',
      'imagery.lightning',
      undefined,
      undefined,
      undefined,
    ],
  );
});

test('rain and radar are one choice: precipitation by default, one on turns the other off', () => {
  assert.equal(weatherImageryOn([], 'imagery.precipitation'), true);
  assert.equal(weatherImageryOn([], 'imagery.radar'), false, 'both allowed: radar yields');
  const radar = withWeatherImagery([], 'imagery.radar', true);
  assert.equal(weatherImageryOn(radar, 'imagery.radar'), true);
  assert.equal(weatherImageryOn(radar, 'imagery.precipitation'), false);
  const back = withWeatherImagery(radar, 'imagery.precipitation', true);
  assert.equal(weatherImageryOn(back, 'imagery.precipitation'), true);
  assert.equal(weatherImageryOn(back, 'imagery.radar'), false);
  assert.deepEqual(withWeatherImagery([], 'imagery.lightning', false), ['imagery.lightning']);
});

test('Weather off takes every weather picture away; imagery views only when chosen; weather on top', () => {
  assert.deepEqual(ids([]), [
    'usgs-topo',
    'gibs-goes-east-infrared',
    'eumetsat-meteosat-infrared',
    'gibs-imerg-precipitation',
    'nowcoast-strike-density',
  ]);
  assert.deepEqual(ids(['weather']), ['usgs-topo']);
  assert.deepEqual(ids([], overview, { imagery: 'gibs-viirs-noaa20-true-colour' }).slice(0, 2), [
    'gibs-viirs-noaa20-true-colour',
    'usgs-topo',
  ]);
  assert.equal(
    ids(['weather'], overview, { comparing: true }).filter((x) => x.includes('true-colour')).length,
    2,
    'the comparison draws both of its sides',
  );
  assert.deepEqual(ids([], aviation), ['usgs-topo'], 'no rain colours in the Aviation lens');
  assert.equal(ids(['weather'], weatherLens).length, 5, "the Weather lens is not the Overview's switch");
  assert.equal(weatherImageryAllowed(undefined, []), true);
});

test('an unseamed infrared mosaic gives way to the seamed slices it overlaps', () => {
  const withNowcoast = [...shipped, o('nowcoast-goes-infrared')];
  const shown = visibleOverlays(withNowcoast, overview, []).map((x) => x.providerId);
  assert.ok(!shown.includes('nowcoast-goes-infrared'));
  const alone = visibleOverlays([o('nowcoast-goes-infrared')], overview, []).map((x) => x.providerId);
  assert.deepEqual(alone, ['nowcoast-goes-infrared'], 'drawn when it is the only cloud picture');
});

test('the layer panel lists the weather imagery inside Weather, and nowhere else', () => {
  const withImagery = LAYER_GROUPS.filter((g) => g.imagery?.length);
  assert.deepEqual(
    withImagery.map((g) => g.id),
    ['weather'],
  );
  assert.deepEqual(
    withImagery[0]!.imagery!.map((i) => i.name),
    ['Satellite clouds', 'Precipitation', 'Radar', 'Lightning'],
  );
});
