import { EARTH_RADIUS_M, type GeoPosition } from '@worldview/world-model';
import { splitAtAntimeridian, type RenderFeature } from '@worldview/render-core';

/**
 * The selected satellite's footprint: where on the ground it is above the horizon right now,
 * and where it is at least 10° up — the elevation its listed passes start at (celestrak
 * `PASS_MIN_ELEVATION_DEG`), below which buildings, trees and haze usually hide it. Two rings
 * round the point beneath it, following it as it moves; map features on their own layer,
 * never pick targets. A spherical Earth is close enough for a ring thousands of kilometres
 * across (well under 1% of its radius).
 */
export const FOOTPRINT_LAYER = 'footprint';
export const FOOTPRINT_ELEVATIONS_DEG = [0, 10] as const;
const RING_VERTICES = 144;
const DEG = Math.PI / 180;

/**
 * The Earth-central angle (degrees) from the point beneath a satellite at `altitudeM` to where
 * it stands `elevationDeg` above the horizon; undefined if it never does (too low an orbit).
 */
export function footprintAngleDeg(altitudeM: number, elevationDeg: number): number | undefined {
  if (!(altitudeM > 0)) return undefined;
  const ε = elevationDeg * DEG;
  const c = (EARTH_RADIUS_M / (EARTH_RADIUS_M + altitudeM)) * Math.cos(ε);
  const λ = Math.acos(Math.min(1, c)) - ε;
  return λ > 0 ? λ / DEG : undefined;
}

/** The point `angleDeg` of arc from `from` along `bearingDeg`, on the sphere. */
function along(from: GeoPosition, bearingDeg: number, angleDeg: number): GeoPosition {
  const φ1 = from.latitude * DEG;
  const λ1 = from.longitude * DEG;
  const θ = bearingDeg * DEG;
  const δ = angleDeg * DEG;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { latitude: φ2 / DEG, longitude: ((((λ2 / DEG + 180) % 360) + 360) % 360) - 180 };
}

/** A ring `angleDeg` of arc round `center`, closed, as positions. */
export function footprintRing(center: GeoPosition, angleDeg: number): GeoPosition[] {
  const out: GeoPosition[] = [];
  for (let i = 0; i <= RING_VERTICES; i++) out.push(along(center, (360 * i) / RING_VERTICES, angleDeg));
  return out;
}

/**
 * The footprint rings for a satellite at `position` (its altitude above the ground), each
 * named where it is easiest to read: at its north, or its south when the ring goes round the
 * North Pole.
 */
export function footprintFeatures(position: GeoPosition): RenderFeature[] {
  const out: RenderFeature[] = [];
  const center = { latitude: position.latitude, longitude: position.longitude };
  for (const elevationDeg of FOOTPRINT_ELEVATIONS_DEG) {
    const angle = footprintAngleDeg(position.altitudeM ?? 0, elevationDeg);
    if (angle === undefined) continue;
    const horizon = elevationDeg === 0;
    splitAtAntimeridian(footprintRing(center, angle)).forEach((piece, i) => {
      if (piece.length < 2) return;
      out.push({
        id: `footprint:${elevationDeg}${i ? `:${i}` : ''}`,
        geometry: { kind: 'line', positions: piece },
        style: {
          styleClass: horizon ? 'footprint.horizon' : 'footprint',
          size: horizon ? 1 : 1.5,
          lineStyle: horizon ? 'dashed' : 'solid',
        },
        interactive: false,
        priority: 3,
        layer: FOOTPRINT_LAYER,
      });
    });
    const roundNorthPole = center.latitude + angle > 90;
    out.push({
      id: `footprint:label:${elevationDeg}`,
      geometry: { kind: 'point', position: along(center, roundNorthPole ? 180 : 0, angle) },
      style: {
        styleClass: 'footprint.label',
        size: 2,
        label: horizon ? 'horizon' : `${elevationDeg}° up`,
        labelPriority: 3,
      },
      interactive: false,
      priority: 3,
      layer: FOOTPRINT_LAYER,
    });
  }
  return out;
}
