import { haversineMeters, isValidBounds, normalizeLongitude, type GeoBounds } from '@worldview/world-model';
import { ADSB_LOL_MAX_RADIUS_NM } from './manifest.js';

/**
 * Circles of 250 nm laid over a view that one point query cannot cover.
 *
 * adsb.lol answers "every aircraft within 250 nm of a point" and nothing wider (its OpenAPI
 * has no bounding-box or all-aircraft query: point/lat-lon-dist, closest, callsign, hex,
 * registration, squawk, type and the mil/LADD/PIA lists). A regional or continental view —
 * Europe, the United States — is therefore covered by several point queries, one a poll in
 * turn, each answer kept until it is refreshed or ten minutes old (coverage.ts decides which
 * circle next; index.ts keeps the answers).
 *
 * The circles sit on one fixed worldwide grid, not on a grid anchored to the view: a view
 * that pans by a few degrees keeps most of its circles, and their answers (and the HTTP
 * cache's entries, keyed on the URL) with them. The grid is a square lattice in latitude
 * rows. Each cell is a square `CELL_NM` on a side at its equatorward edge (the widest point
 * of the cell once longitudes converge), and a circle centred in the cell reaches its
 * farthest corner — `CELL_NM / √2` = `DESIGN_RADIUS_NM` — so every point of the cell is
 * inside that cell's circle. The design radius is 5 nm under the query's 250 to absorb the
 * two-decimal rounding of the centre in the URL and the flat-cell approximation;
 * `tiles.test.ts` checks the cover by sampling. A hexagonal packing would need about a
 * quarter fewer circles, but only while neighbouring rows interlock, which rows of
 * different longitude spacing do not; a square cell is covered by its own circle alone.
 *
 * Rows stop at ±84° (nothing polewards but the odd polar flight, which a view up there
 * gets from its own point query). Longitude columns wrap at the antimeridian: each row's
 * spacing divides 360° exactly.
 */
export const DESIGN_RADIUS_NM = ADSB_LOL_MAX_RADIUS_NM - 5;
const CELL_NM = DESIGN_RADIUS_NM * Math.SQRT2;
const CELL_LAT_DEG = CELL_NM / 60;
const MAX_ROW_LAT = 84;
const METERS_PER_NM = 1852;

export interface Tile {
  /** Stable grid address `row:column`. */
  id: string;
  latitude: number;
  longitude: number;
  radiusNm: number;
}

interface Row {
  index: number;
  south: number;
  north: number;
  columns: number;
}

function row(index: number): Row {
  const south = index * CELL_LAT_DEG;
  const north = south + CELL_LAT_DEG;
  // The equatorward edge is the widest part of the cell: the longitude step is set there.
  const equatorward = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
  const stepDeg = CELL_LAT_DEG / Math.cos((equatorward * Math.PI) / 180);
  return { index, south, north, columns: Math.max(1, Math.ceil(360 / stepDeg)) };
}

function tileOf(r: Row, column: number): Tile {
  const step = 360 / r.columns;
  const lat = Math.max(-MAX_ROW_LAT, Math.min(MAX_ROW_LAT, (r.south + r.north) / 2));
  return {
    id: `${r.index}:${column}`,
    latitude: round2(lat),
    longitude: round2(normalizeLongitude(-180 + (column + 0.5) * step)),
    radiusNm: ADSB_LOL_MAX_RADIUS_NM,
  };
}

/** Column index ranges ([first, last], inclusive) whose cells meet [west, east] (antimeridian-aware). */
function columnRanges(r: Row, west: number, east: number): Array<[number, number]> {
  const step = 360 / r.columns;
  const span = west <= east ? east - west : east - west + 360;
  if (span >= 360 - 1e-9) return [[0, r.columns - 1]];
  const first = Math.floor((west + 180) / step);
  const count = Math.floor((west + 180 + span) / step) - first + 1;
  if (count >= r.columns) return [[0, r.columns - 1]];
  const a = ((first % r.columns) + r.columns) % r.columns;
  const b = a + count - 1;
  return b < r.columns
    ? [[a, b]]
    : [
        [a, r.columns - 1],
        [0, b - r.columns],
      ];
}

/**
 * The grid circles that together cover `bounds` (every cell the bounds touch), or undefined
 * when that would take more than `max` circles — a view that wide is left to the worldwide
 * type rotation (coverage.ts). The count is known row by row before any tile is built, so a
 * globe-wide view costs a few dozen multiplications, not a thousand tiles.
 */
export function tilesForBounds(bounds: GeoBounds, max: number): Tile[] | undefined {
  if (!isValidBounds(bounds)) return undefined;
  const south = Math.max(-MAX_ROW_LAT, bounds.south);
  const north = Math.min(MAX_ROW_LAT, bounds.north);
  if (south > north) return [];
  const first = Math.floor(south / CELL_LAT_DEG);
  const last = Math.min(Math.floor(north / CELL_LAT_DEG), Math.ceil(MAX_ROW_LAT / CELL_LAT_DEG) - 1);
  const rows: Array<{ r: Row; ranges: Array<[number, number]> }> = [];
  let total = 0;
  for (let i = first; i <= last; i++) {
    const r = row(i);
    const ranges = columnRanges(r, bounds.west, bounds.east);
    for (const [a, b] of ranges) total += b - a + 1;
    if (total > max) return undefined;
    rows.push({ r, ranges });
  }
  const out: Tile[] = [];
  for (const { r, ranges } of rows) for (const [a, b] of ranges) for (let c = a; c <= b; c++) out.push(tileOf(r, c));
  return out;
}

/** Whether a position is inside a query circle (a tile's, or any point query's). */
export function tileContains(
  t: { latitude: number; longitude: number; radiusNm: number },
  p: { latitude: number; longitude: number },
): boolean {
  if (Math.abs(p.latitude - t.latitude) > t.radiusNm / 60 + 0.01) return false;
  return haversineMeters(t, p) <= t.radiusNm * METERS_PER_NM;
}

/**
 * Where aircraft are before any circle has answered: busy terminal areas, each with a
 * rough count of the aircraft adsb.lol typically shows within 250 nm of it at a busy hour.
 *
 * These numbers are this project's own rough estimates, written for this table and not
 * taken from any dataset; the coordinates are the airports' public reference points to two
 * decimals. They do one thing: order the first pass over a wide view so the busy circles
 * are asked for first. Once a circle has answered, its own count replaces the estimate
 * (coverage.ts), so a wrong number here costs a slower first pass, never a missing circle.
 */
export const TRAFFIC_PRIOR: ReadonlyArray<{ name: string; latitude: number; longitude: number; aircraft: number }> =
  Object.freeze([
    // Europe
    { name: 'London', latitude: 51.47, longitude: -0.45, aircraft: 650 },
    { name: 'Paris', latitude: 49.01, longitude: 2.55, aircraft: 500 },
    { name: 'Frankfurt', latitude: 50.03, longitude: 8.57, aircraft: 500 },
    { name: 'Amsterdam', latitude: 52.31, longitude: 4.76, aircraft: 450 },
    { name: 'Zurich', latitude: 47.46, longitude: 8.55, aircraft: 400 },
    { name: 'Munich', latitude: 48.35, longitude: 11.79, aircraft: 350 },
    { name: 'Milan', latitude: 45.63, longitude: 8.72, aircraft: 300 },
    { name: 'Vienna', latitude: 48.11, longitude: 16.57, aircraft: 300 },
    { name: 'Madrid', latitude: 40.47, longitude: -3.56, aircraft: 300 },
    { name: 'Barcelona', latitude: 41.3, longitude: 2.08, aircraft: 250 },
    { name: 'Rome', latitude: 41.8, longitude: 12.25, aircraft: 250 },
    { name: 'Istanbul', latitude: 41.26, longitude: 28.74, aircraft: 350 },
    { name: 'Moscow', latitude: 55.97, longitude: 37.41, aircraft: 250 },
    { name: 'Copenhagen', latitude: 55.62, longitude: 12.65, aircraft: 200 },
    { name: 'Dublin', latitude: 53.42, longitude: -6.27, aircraft: 200 },
    { name: 'Warsaw', latitude: 52.17, longitude: 20.97, aircraft: 150 },
    { name: 'Athens', latitude: 37.94, longitude: 23.94, aircraft: 150 },
    { name: 'Lisbon', latitude: 38.77, longitude: -9.13, aircraft: 150 },
    { name: 'Stockholm', latitude: 59.65, longitude: 17.93, aircraft: 120 },
    { name: 'Oslo', latitude: 60.19, longitude: 11.1, aircraft: 100 },
    // North America
    { name: 'New York', latitude: 40.64, longitude: -73.78, aircraft: 600 },
    { name: 'Chicago', latitude: 41.97, longitude: -87.9, aircraft: 550 },
    { name: 'Atlanta', latitude: 33.64, longitude: -84.43, aircraft: 500 },
    { name: 'Washington', latitude: 38.95, longitude: -77.46, aircraft: 450 },
    { name: 'Dallas', latitude: 32.9, longitude: -97.04, aircraft: 450 },
    { name: 'Los Angeles', latitude: 33.94, longitude: -118.41, aircraft: 450 },
    { name: 'Charlotte', latitude: 35.21, longitude: -80.94, aircraft: 400 },
    { name: 'Denver', latitude: 39.86, longitude: -104.67, aircraft: 350 },
    { name: 'Miami', latitude: 25.79, longitude: -80.29, aircraft: 350 },
    { name: 'Boston', latitude: 42.36, longitude: -71.01, aircraft: 350 },
    { name: 'Houston', latitude: 29.98, longitude: -95.34, aircraft: 300 },
    { name: 'Orlando', latitude: 28.43, longitude: -81.31, aircraft: 300 },
    { name: 'San Francisco', latitude: 37.62, longitude: -122.38, aircraft: 300 },
    { name: 'Toronto', latitude: 43.68, longitude: -79.63, aircraft: 300 },
    { name: 'Phoenix', latitude: 33.43, longitude: -112.01, aircraft: 250 },
    { name: 'Las Vegas', latitude: 36.08, longitude: -115.15, aircraft: 250 },
    { name: 'Minneapolis', latitude: 44.88, longitude: -93.22, aircraft: 200 },
    { name: 'Seattle', latitude: 47.45, longitude: -122.31, aircraft: 200 },
    { name: 'Mexico City', latitude: 19.44, longitude: -99.07, aircraft: 200 },
    // Elsewhere
    { name: 'Tokyo', latitude: 35.55, longitude: 139.78, aircraft: 350 },
    { name: 'Hong Kong', latitude: 22.31, longitude: 113.91, aircraft: 350 },
    { name: 'Shanghai', latitude: 31.14, longitude: 121.8, aircraft: 300 },
    { name: 'Dubai', latitude: 25.25, longitude: 55.36, aircraft: 300 },
    { name: 'Seoul', latitude: 37.46, longitude: 126.44, aircraft: 250 },
    { name: 'Beijing', latitude: 40.08, longitude: 116.58, aircraft: 250 },
    { name: 'Delhi', latitude: 28.56, longitude: 77.1, aircraft: 250 },
    { name: 'Singapore', latitude: 1.36, longitude: 103.99, aircraft: 200 },
    { name: 'Bangkok', latitude: 13.69, longitude: 100.75, aircraft: 200 },
    { name: 'São Paulo', latitude: -23.43, longitude: -46.47, aircraft: 200 },
    { name: 'Sydney', latitude: -33.95, longitude: 151.18, aircraft: 150 },
    { name: 'Johannesburg', latitude: -26.14, longitude: 28.24, aircraft: 100 },
  ]);

/** What a circle with no busy area in it is assumed to hold until it has answered. */
export const PRIOR_BASELINE = 5;

/** The busiest prior area inside a tile's circle, or the baseline. */
export function priorAircraft(t: Tile): number {
  let best = PRIOR_BASELINE;
  for (const p of TRAFFIC_PRIOR) if (p.aircraft > best && tileContains(t, p)) best = p.aircraft;
  return best;
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}
