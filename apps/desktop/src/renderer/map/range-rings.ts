import type { GeoPosition } from '@worldview/world-model';
import type { RenderFeature, ViewState } from '@worldview/render-core';
import { formatDistance } from './measure.js';

/**
 * Range rings (R): evenly spaced circles round the selected object, with the distance of each
 * written on it at the top — how far a ship, a fire or an aircraft is from everything round it,
 * at a glance. The spacing is a round number chosen from the view, so the outer ring sits well
 * inside it whatever the zoom; it changes only when the view does by a step, not with every
 * movement of the camera. Map features on their own layer, never pick targets.
 */
export const RANGE_RINGS_LAYER = 'range-rings';
export const RANGE_RING_COUNT = 4;
/** Spacings the rings step through (metres): 1-2-5 from 100 m to 2,000 km. */
export const RING_STEPS_M = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000,
] as const;
const EARTH_M_PER_DEG = 111_320;
/** The mean Earth radius the distance measure uses (world-model `haversineMeters`). */
const EARTH_RADIUS_M = 6_371_008.8;

/** The point `distanceM` due north of `p` (along its meridian; past the pole, the pole). */
function northOf(p: GeoPosition, distanceM: number): GeoPosition {
  return {
    latitude: Math.min(90, p.latitude + (distanceM / EARTH_RADIUS_M) * (180 / Math.PI)),
    longitude: p.longitude,
  };
}

/**
 * The spacing for a view: the smallest step whose four rings reach at least a fifth of the
 * view's narrower side — the outer ring then spans between about a fifth and half of it.
 * Undefined until the renderer has said what the view shows.
 */
export function ringSpacingM(view: ViewState): number | undefined {
  const b = view.bounds;
  if (!b) return undefined;
  const east = b.east < b.west ? b.east + 360 : b.east;
  const midLat = ((b.north + b.south) / 2) * (Math.PI / 180);
  const widthM = Math.min(360, east - b.west) * EARTH_M_PER_DEG * Math.max(0.05, Math.cos(midLat));
  const heightM = Math.max(0, b.north - b.south) * EARTH_M_PER_DEG;
  const side = Math.min(widthM, heightM || widthM);
  if (!(side > 0)) return undefined;
  const want = side / 5 / RANGE_RING_COUNT;
  for (const s of RING_STEPS_M) if (s >= want) return s;
  return RING_STEPS_M[RING_STEPS_M.length - 1];
}

/** The rings round `center`, `spacingM` apart, each named at its northern point. */
export function rangeRingFeatures(center: GeoPosition, spacingM: number): RenderFeature[] {
  const out: RenderFeature[] = [];
  const c = { latitude: center.latitude, longitude: center.longitude };
  for (let i = 1; i <= RANGE_RING_COUNT; i++) {
    const radiusM = spacingM * i;
    out.push({
      id: `range-ring:${i}`,
      geometry: { kind: 'circle', center: c, radiusM },
      style: { styleClass: 'range-ring', size: 1.5, lineStyle: 'solid' },
      interactive: false,
      priority: 2,
      layer: RANGE_RINGS_LAYER,
    });
    out.push({
      id: `range-ring:label:${i}`,
      geometry: { kind: 'point', position: northOf(c, radiusM) },
      style: { styleClass: 'range-ring.label', size: 2, label: formatDistance(radiusM), labelPriority: 2 },
      interactive: false,
      priority: 2,
      layer: RANGE_RINGS_LAYER,
    });
  }
  return out;
}
