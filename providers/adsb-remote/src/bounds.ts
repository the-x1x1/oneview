import {
  haversineMeters,
  isValidBounds,
  isValidLatLon,
  normalizeLongitude,
  type GeoBounds,
  type JsonValue,
} from '@worldview/world-model';
import { ADSB_LOL_MAX_RADIUS_NM } from './manifest.js';

/** A point query: centre + radius in nautical miles (adsb.lol `/lat/{lat}/lon/{lon}/dist/{nm}`). */
export interface PointQuery {
  latitude: number;
  longitude: number;
  radiusNm: number;
  /** True when the requested bounds exceed the API's radius cap and the query was clipped. */
  clipped: boolean;
}

const METERS_PER_NM = 1852;
/** Centre quantisation step (degrees). Keeps the endpoint stable while the viewport jitters. */
const CENTER_STEP_DEG = 0.1;
/** Radius quantisation step (nm). */
const RADIUS_STEP_NM = 5;
/** Margin covering centre quantisation error (≤ 0.05° ≈ 3 nm at the equator). */
const MARGIN_NM = 5;

/** Derive the point query that covers the given bounds (antimeridian-aware), capped at the API maximum. */
export function pointQueryForBounds(bounds: GeoBounds, maxRadiusNm = ADSB_LOL_MAX_RADIUS_NM): PointQuery | undefined {
  if (!isValidBounds(bounds)) return undefined;
  const widthDeg = bounds.west <= bounds.east ? bounds.east - bounds.west : bounds.east - bounds.west + 360;
  const centreLat = quantize((bounds.south + bounds.north) / 2, CENTER_STEP_DEG);
  const centreLon = quantize(normalizeLongitude(bounds.west + widthDeg / 2), CENTER_STEP_DEG);
  const centre = { latitude: clampLat(centreLat), longitude: Math.max(-180, Math.min(180, centreLon)) };
  // The farthest corner from the centre bounds the radius; use all four to be safe near the poles.
  const corners = [
    { latitude: bounds.north, longitude: bounds.east },
    { latitude: bounds.north, longitude: bounds.west },
    { latitude: bounds.south, longitude: bounds.east },
    { latitude: bounds.south, longitude: bounds.west },
  ];
  const farthestM = Math.max(...corners.map((c) => haversineMeters(centre, c)));
  const wantedNm = Math.ceil((farthestM / METERS_PER_NM + MARGIN_NM) / RADIUS_STEP_NM) * RADIUS_STEP_NM;
  const radiusNm = Math.max(RADIUS_STEP_NM, Math.min(maxRadiusNm, wantedNm));
  return { latitude: centre.latitude, longitude: centre.longitude, radiusNm, clipped: wantedNm > maxRadiusNm };
}

export interface HomePosition {
  latitude: number;
  longitude: number;
  radiusNm: number;
}

/** Parse `settings.homePosition` (`{ latitude, longitude, radiusNm? }`); undefined when absent or invalid. */
export function parseHomePosition(
  raw: JsonValue | undefined,
  defaultRadiusNm = 100,
  maxRadiusNm = ADSB_LOL_MAX_RADIUS_NM,
): HomePosition | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, JsonValue | undefined>;
  const lat = o['latitude'];
  const lon = o['longitude'];
  if (!isValidLatLon(lat, lon)) return undefined;
  const r = o['radiusNm'];
  const radiusNm = typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.min(maxRadiusNm, r) : defaultRadiusNm;
  return { latitude: lat, longitude: lon as number, radiusNm };
}

function quantize(v: number, step: number): number {
  // Round to the step, then drop binary noise (0.1 steps → one decimal).
  return Number((Math.round(v / step) * step).toFixed(6));
}

function clampLat(v: number): number {
  return Math.max(-90, Math.min(90, v));
}
