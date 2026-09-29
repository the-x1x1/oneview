import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, type GeoBounds } from '@worldview/world-model';
import { PRIOR_BASELINE, TRAFFIC_PRIOR, priorAircraft, tileContains, tilesForBounds, type Tile } from './tiles.js';

const EUROPE: GeoBounds = { west: -25, south: 34, east: 45, north: 70 };
const EUROPE_CORE: GeoBounds = { west: -12, south: 36, east: 30, north: 60 };
const CONUS: GeoBounds = { west: -125, south: 24, east: -66, north: 50 };
const WORLD: GeoBounds = { west: -180, south: -85, east: 180, north: 85 };

/** The farthest any sampled point of `bounds` is from the nearest of `tiles`, in nm. */
function worstGapNm(bounds: GeoBounds, tiles: readonly Tile[], stepDeg: number): number {
  let worst = 0;
  const width = bounds.west <= bounds.east ? bounds.east - bounds.west : bounds.east - bounds.west + 360;
  for (let lat = Math.max(-84, bounds.south); lat <= Math.min(84, bounds.north); lat += stepDeg)
    for (let dx = 0; dx <= width; dx += stepDeg) {
      const lon = ((bounds.west + dx + 540) % 360) - 180;
      let best = Infinity;
      for (const t of tiles) {
        if (Math.abs(t.latitude - lat) > 7) continue;
        best = Math.min(best, haversineMeters(t, { latitude: lat, longitude: lon }) / 1852);
      }
      worst = Math.max(worst, best);
    }
  return worst;
}

test('tilesForBounds: every point of a regional view is inside one of its 250 nm circles', () => {
  for (const [name, b] of [
    ['Europe', EUROPE],
    ['contiguous US', CONUS],
    ['across the antimeridian', { west: 165, south: 40, east: -160, north: 62 }],
    ['the far north', { west: 0, south: 66, east: 40, north: 84 }],
    ['the equator', { west: 95, south: -10, east: 120, north: 10 }],
  ] as const) {
    const tiles = tilesForBounds(b, 500)!;
    const gap = worstGapNm(b, tiles, 0.25);
    assert.ok(gap <= 250, `${name}: a point ${gap.toFixed(1)} nm from the nearest circle centre`);
    for (const t of tiles) assert.equal(t.radiusNm, 250);
  }
});

test('tilesForBounds: the whole grid covers the world (to 84°) with every circle inside the API cap', () => {
  const all = tilesForBounds(WORLD, 10_000)!;
  assert.ok(all.length > 1000 && all.length < 1500, `${all.length} circles`);
  assert.ok(worstGapNm(WORLD, all, 1) <= 250);
  assert.equal(new Set(all.map((t) => t.id)).size, all.length, 'ids are unique');
});

test('tilesForBounds: how many circles a region takes, and a view too wide for them', () => {
  assert.equal(tilesForBounds(EUROPE_CORE, 500)!.length, 30);
  assert.equal(tilesForBounds(CONUS, 500)!.length, 48);
  assert.equal(tilesForBounds(EUROPE, 500)!.length, 73);
  assert.equal(tilesForBounds(WORLD, 80), undefined, 'the whole world is over any sensible cap');
  assert.equal(tilesForBounds(EUROPE, 72), undefined);
  assert.equal(tilesForBounds({ west: 0, south: 50, east: 1, north: 51 }, 80)!.length, 1);
  assert.equal(tilesForBounds({ west: 0, south: 89, east: 1, north: 90 }, 80)!.length, 0, 'polewards of the grid');
});

test('tilesForBounds: the grid is fixed to the world, so a small pan keeps most circles unchanged', () => {
  const a = tilesForBounds(CONUS, 500)!;
  const b = tilesForBounds(
    { west: CONUS.west + 0.7, south: CONUS.south + 0.4, east: CONUS.east + 0.7, north: CONUS.north + 0.4 },
    500,
  )!;
  const byId = new Map(a.map((t) => [t.id, t]));
  const shared = b.filter((t) => byId.has(t.id));
  assert.ok(shared.length >= 0.8 * a.length, `${shared.length} of ${a.length} circles kept`);
  for (const t of shared) assert.deepEqual(t, byId.get(t.id), 'same centre for the same id (same URL)');
  // Centres are rounded as the URL rounds them.
  for (const t of a) assert.equal(Number(t.latitude.toFixed(2)), t.latitude);
});

test('tilesForBounds: across the antimeridian both sides are covered and longitudes stay in range', () => {
  const tiles = tilesForBounds({ west: 170, south: 50, east: -170, north: 55 }, 80)!;
  assert.ok(tiles.some((t) => t.longitude > 160));
  assert.ok(tiles.some((t) => t.longitude < -160));
  assert.ok(tiles.every((t) => t.longitude >= -180 && t.longitude <= 180));
});

test('priorAircraft: busy terminal areas rank their circle; open sea is the baseline', () => {
  const over = (latitude: number, longitude: number) =>
    tilesForBounds({ west: longitude, south: latitude, east: longitude + 0.01, north: latitude + 0.01 }, 1)![0]!;
  const london = over(51.47, -0.45);
  assert.ok(tileContains(london, TRAFFIC_PRIOR[0]!));
  assert.ok(priorAircraft(london) >= 400, `London's circle: ${priorAircraft(london)}`);
  assert.equal(priorAircraft(over(45, -35)), PRIOR_BASELINE, 'mid-Atlantic');
  assert.ok(priorAircraft(over(33.64, -84.43)) > priorAircraft(over(45, -110)), 'Atlanta over Montana');
});
