import type { GeoBounds, Observation } from '@worldview/world-model';
import {
  ProviderError,
  assertAtomicAdmission,
  type ProviderContext,
  type ProviderManifest,
} from '@worldview/provider-sdk';
import { mapRecords, type CompiledMapping, type ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { classifyCrs } from './crs.js';

/**
 * Axis order, and a page of features through the mapping.
 *
 * GeoJSON is longitude, latitude (RFC 7946), and a WFS asked for WGS 84 is supposed to say
 * which order it used through the CRS name. The services say otherwise: GeoServer (recorded
 * with the URN on 2.0.0 and `EPSG:4326` on 1.1.0, probed with the other two combinations),
 * QGIS Server (recorded with the URN, probed with `EPSG:4326`)
 * and MapServer's demo service (probed, not recorded) all answered GeoJSON in longitude,
 * latitude whether `srsName` was `EPSG:4326` or `urn:ogc:def:crs:EPSG::4326` — and
 * GeoServer's `crs` member named the latitude-first URN while its coordinates were
 * longitude first (fixtures/connectors/ogc/geoserver-wien-wlan-page1.json). A rule that
 * swapped on the CRS name would put every one of those features in the wrong hemisphere.
 *
 * So the order is decided from the data, deterministically:
 * 1. the operator's `axisOrder` setting, when set;
 * 2. CRS84 requested: longitude first, no question;
 * 3. the feature type's WGS 84 bounding box from the capabilities (always longitude first
 *    by definition): whichever reading puts the sampled coordinates inside it, if one
 *    clearly does;
 * 4. the range of the values: a first coordinate beyond ±90 cannot be a latitude;
 * 5. otherwise longitude first, as GeoJSON is written.
 * A swap is recorded on every observation it touched as `payload.crsNote`.
 */
export type AxisSetting = 'auto' | 'lon-lat' | 'lat-lon';

export interface AxisDecision {
  swap: boolean;
  basis: 'setting' | 'crs84' | 'bounds' | 'range' | 'default' | 'no-coordinates';
  /** Why, in a sentence (the crsNote when swapped). */
  reason: string;
}

const SAMPLE = 200;

function firstCoordinate(coords: unknown, depth = 0): [number, number] | undefined {
  if (!Array.isArray(coords) || coords.length === 0 || depth > 6) return undefined;
  if (typeof coords[0] === 'number') {
    const [a, b] = coords as unknown[];
    return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)
      ? [a, b]
      : undefined;
  }
  return firstCoordinate(coords[0], depth + 1);
}

function geometryOf(feature: unknown): { type?: unknown; coordinates?: unknown } | undefined {
  if (!feature || typeof feature !== 'object') return undefined;
  const g = (feature as { geometry?: unknown }).geometry;
  return g && typeof g === 'object' && !Array.isArray(g) ? (g as { type?: unknown; coordinates?: unknown }) : undefined;
}

export function sampleCoordinates(features: unknown[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const f of features) {
    const c = firstCoordinate(geometryOf(f)?.coordinates);
    if (c) out.push(c);
    if (out.length >= SAMPLE) break;
  }
  return out;
}

function expand(b: GeoBounds): GeoBounds {
  const mx = Math.max(0.05, (b.east - b.west) * 0.1);
  const my = Math.max(0.05, (b.north - b.south) * 0.1);
  return { west: b.west - mx, east: b.east + mx, south: b.south - my, north: b.north + my };
}

const inside = (b: GeoBounds, lon: number, lat: number) =>
  lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;

export function decideAxisOrder(
  samples: Array<[number, number]>,
  opts: { setting?: AxisSetting; requestedCrs?: string; bounds?: GeoBounds },
): AxisDecision {
  if (opts.setting === 'lon-lat') return { swap: false, basis: 'setting', reason: 'operator setting: longitude first' };
  if (opts.setting === 'lat-lon') return { swap: true, basis: 'setting', reason: 'operator setting axisOrder=lat-lon' };
  if (opts.requestedCrs && classifyCrs(opts.requestedCrs).kind === 'crs84')
    return { swap: false, basis: 'crs84', reason: 'CRS84 requested: longitude first' };
  if (samples.length === 0) return { swap: false, basis: 'no-coordinates', reason: 'no coordinates to test' };
  if (opts.bounds) {
    const b = expand(opts.bounds);
    const asLonLat = samples.filter(([x, y]) => inside(b, x, y)).length;
    const asLatLon = samples.filter(([x, y]) => inside(b, y, x)).length;
    if (asLatLon > asLonLat && asLatLon >= 0.8 * samples.length)
      return {
        swap: true,
        basis: 'bounds',
        reason: `${asLatLon} of ${samples.length} sampled coordinates lie in the feature type's WGS 84 bounds only when read latitude first`,
      };
    if (asLonLat > asLatLon && asLonLat >= 0.8 * samples.length)
      return { swap: false, basis: 'bounds', reason: 'coordinates lie in the WGS 84 bounds longitude first' };
  }
  const latBeyond = samples.filter(([, y]) => Math.abs(y) > 90).length;
  const lonBeyond = samples.filter(([x]) => Math.abs(x) > 90).length;
  if (latBeyond > 0 && lonBeyond === 0)
    return {
      swap: true,
      basis: 'range',
      reason: `${latBeyond} sampled coordinate(s) have a second value beyond ±90, which only a longitude can be`,
    };
  return { swap: false, basis: lonBeyond > 0 ? 'range' : 'default', reason: 'GeoJSON order (longitude first)' };
}

/** Coordinates that are not degrees at all: the service did not reproject to WGS 84. */
export function notDegrees(samples: Array<[number, number]>): boolean {
  if (samples.length === 0) return false;
  const bad = samples.filter(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 180).length;
  return bad > samples.length / 2;
}

function swapCoords(coords: unknown, depth = 0): unknown {
  if (!Array.isArray(coords) || depth > 6) return coords;
  if (typeof coords[0] === 'number') {
    const [a, b, ...rest] = coords as number[];
    return [b, a, ...rest];
  }
  return coords.map((c) => swapCoords(c, depth + 1));
}

/** A copy of the feature with every coordinate pair's axes exchanged (the original is untouched). */
export function swapFeatureAxes(feature: unknown): unknown {
  const g = geometryOf(feature);
  if (!g || !Array.isArray(g.coordinates)) return feature;
  return { ...(feature as object), geometry: { ...g, coordinates: swapCoords(g.coordinates) } };
}

/**
 * Refuse a page whose coordinates are not WGS 84 degrees, before the mapping rejects every
 * record for "no position" and the reason is lost.
 */
export function assertWgs84(page: { crsName?: string }, samples: Array<[number, number]>, id: string): void {
  if (page.crsName) {
    const k = classifyCrs(page.crsName).kind;
    if (k === 'other' || k === 'webmercator')
      throw new ProviderError(
        'MALFORMED',
        `${id}: the service answered in ${page.crsName}, not WGS 84 (the connector does not reproject)`,
        { retryable: false },
      );
  }
  if (notDegrees(samples))
    throw new ProviderError(
      'MALFORMED',
      `${id}: the coordinates are not longitude/latitude degrees; the service did not answer in WGS 84`,
      { retryable: false },
    );
}

export interface PageMappingState {
  observations: Observation[];
  seen: Set<string>;
  total: number;
  filtered: number;
  rejected: number;
}

export function newPageState(): PageMappingState {
  return { observations: [], seen: new Set(), total: 0, filtered: 0, rejected: 0 };
}

/**
 * One page of features through the definition's mapping, added to the poll's state (ids
 * already seen on an earlier page are skipped and counted). A non-empty page from which
 * nothing at all could be mapped is MALFORMED: the mapping does not fit this service.
 */
export function mapFeaturePage(
  features: unknown[],
  state: PageMappingState,
  opts: {
    context: ProviderContext;
    manifest: ProviderManifest;
    definition: ConnectorProviderDefinition;
    mapping: CompiledMapping;
    origin: 'live' | 'cached';
    sourceRef: string;
    swap?: AxisDecision;
    invalidate: () => void;
  },
): { added: number; repeated: number } {
  const records = opts.swap?.swap ? features.map(swapFeatureAxes) : features;
  const mapped = mapRecords(records, {
    manifest: opts.manifest,
    definition: opts.definition,
    mapping: opts.mapping,
    receivedAt: new Date(opts.context.clock.now()).toISOString(),
    origin: opts.origin,
    sourceRef: opts.sourceRef,
    hash: (s) => opts.context.hash.sha256Hex(s),
  });
  state.total += mapped.total;
  state.filtered += mapped.filtered;
  state.rejected += mapped.rejected.length;
  if (mapped.rejected.length)
    opts.context.logger.warn('rejected records', {
      count: mapped.rejected.length,
      sample: mapped.rejected.slice(0, 3).map((r) => r.reason),
    });
  if (mapped.total > 0 && mapped.observations.length === 0 && mapped.filtered === 0) {
    opts.invalidate();
    assertAtomicAdmission(mapped.total, 0, `${opts.definition.id} feed`);
  }
  let added = 0;
  let repeated = 0;
  for (const o of mapped.observations) {
    const key = o.externalId ?? o.id;
    if (state.seen.has(key)) {
      repeated++;
      continue;
    }
    state.seen.add(key);
    if (opts.swap?.swap) o.payload['crsNote'] = `axis order swapped to longitude, latitude: ${opts.swap.reason}`;
    state.observations.push(o);
    added++;
  }
  return { added, repeated };
}

/** A page after the first that brought only features already seen: the service is not paging. */
export function repeatedPage(pageIndex: number, r: { added: number; repeated: number }): boolean {
  return pageIndex > 0 && r.added === 0 && r.repeated > 0;
}
