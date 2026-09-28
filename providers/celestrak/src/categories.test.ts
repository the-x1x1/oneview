import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SATELLITE_CATEGORIES, categoryFromName, satelliteCategory } from './categories.js';

test('categoryFromName: well-known names, whole words only', () => {
  const cases: Array<[string, string | undefined]> = [
    ['ISS (ZARYA)', 'station'],
    ['CSS (TIANHE)', 'station'],
    ['STARLINK-30001', 'starlink'],
    ['NAVSTAR 78 (USA 293)', 'navigation'], // a GPS satellite is navigation before it is "USA"
    ['GSAT0101 (GALILEO-PFM)', 'navigation'],
    ['BEIDOU-3 M1', 'navigation'],
    ['NOAA 20 (JPSS-1)', 'weather'],
    ['METEOR-M 2', 'weather'],
    ['GOES 16', 'weather'],
    ['SENTINEL-2A', 'earth-observation'],
    ['LANDSAT 9', 'earth-observation'],
    ['AQUA', 'earth-observation'],
    ['HST', 'science'],
    ['USA 245', 'military'],
    ['YAOGAN-30 A', 'military'],
    ['ONEWEB-0012', 'comms'],
    ['IRIDIUM 180', 'comms'],
    ['SES-14', 'comms'],
    ['COSMOS 2251 DEB', 'debris'],
    ['CZ-4C R/B', 'rocket-body'],
    ['GPSAT', undefined], // not "GPS"
    ['AQUARIUS', undefined], // not "AQUA"
    ['LEMUR-2 JOEL', undefined],
  ];
  for (const [name, want] of cases) assert.equal(categoryFromName(name), want, name);
});

test('satelliteCategory: CelesTrak lists first, then the fetched group, then the name, else other', () => {
  const military = new Set([90001]);
  const gnss = new Set([44506, 90002]);
  const memberOf = (g: 'military' | 'gnss', id: number) => (g === 'military' ? military : gnss).has(id);
  assert.equal(satelliteCategory({ noradId: 90001, name: 'COSMOS 2558' }, 'active', memberOf), 'military');
  assert.equal(satelliteCategory({ noradId: 90002, name: 'COSMOS 2545' }, 'active', memberOf), 'navigation');
  assert.equal(satelliteCategory({ noradId: 90003, name: 'COSMOS 2545' }, 'active', memberOf), 'other');
  assert.equal(satelliteCategory({ noradId: 90004, name: 'SOYUZ-MS 27' }, 'stations', memberOf), 'station');
  assert.equal(satelliteCategory({ noradId: 90005, name: 'TIANQI 7' }, 'weather'), 'weather', 'group decides');
  assert.equal(satelliteCategory({ noradId: 90006, name: 'STARLINK-1007' }, 'active'), 'starlink', 'name decides');
  assert.equal(
    satelliteCategory({ noradId: 90001, name: 'FENGYUN 1C DEB' }, 'active', memberOf),
    'debris',
    'debris is debris whatever list it is on',
  );
  assert.equal(satelliteCategory({ noradId: 90007, name: 'OBJECT A' }, 'active'), 'other');
});

test('every category is a plain lowercase token (it becomes a style-class suffix)', () => {
  for (const c of SATELLITE_CATEGORIES) assert.match(c, /^[a-z]+(-[a-z]+)*$/);
});
