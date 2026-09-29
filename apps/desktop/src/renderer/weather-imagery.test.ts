import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleOverlays, weatherImageryAllowed, weatherImageryFor } from './weather-imagery.js';
import { LAYER_GROUPS } from './layer-tree.js';

const o = (providerId: string) => ({ providerId });
const shipped = [
  'gibs-goes-east-infrared',
  'eumetsat-meteosat-infrared',
  'gibs-imerg-precipitation',
  'nowcoast-radar',
  'nowcoast-strike-density',
  'gibs-viirs-snpp-true-colour',
  'usgs-topo',
].map(o);
const overview = { id: 'overview', objectTypes: ['aircraft', 'storm'] };
const aviation = { id: 'aviation', objectTypes: ['aircraft', 'airport'] };
const weatherLens = { id: 'weather', objectTypes: ['weather-alert', 'storm'] };

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
    ],
  );
});

test('Weather off in the Overview takes every weather picture off the map, and only those', () => {
  const ids = (hidden: string[], lens = overview) => visibleOverlays(shipped, lens, hidden).map((x) => x.providerId);
  assert.equal(ids([]).length, shipped.length, 'all on by default');
  assert.deepEqual(ids(['weather']), ['gibs-viirs-snpp-true-colour', 'usgs-topo']);
  assert.deepEqual(
    ids(['imagery.infrared', 'imagery.radar']),
    ['gibs-imerg-precipitation', 'nowcoast-strike-density', 'gibs-viirs-snpp-true-colour', 'usgs-topo'],
    'one kind at a time',
  );
  assert.deepEqual(
    ids([], aviation),
    ['gibs-viirs-snpp-true-colour', 'usgs-topo'],
    'no rain colours in the Aviation lens',
  );
  assert.equal(ids(['weather'], weatherLens).length, shipped.length, "the Weather lens is not the Overview's switch");
  assert.equal(weatherImageryAllowed(undefined, []), true);
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
