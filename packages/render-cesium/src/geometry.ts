import type { RenderStyle } from '@worldview/render-core';
import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type { Cartesian3Like, CesiumLike, RectangleLike } from './cesium-like.js';

/**
 * Geographic → Cesium coordinate helpers. Height handling follows the feature's
 * `heightMode`: absolute uses the object's altitude (aircraft, satellites),
 * clamp draws at 0 and lets the primitive clamp to ground, relative keeps the
 * altitude as a ground offset.
 */
export type HeightMode = NonNullable<RenderStyle['heightMode']>;

/** Height (m) to hand Cesium for a position under a height mode; pure and tested. */
export function heightFor(position: GeoPosition, mode: HeightMode | undefined): number {
  const m = mode ?? 'clamp';
  if (m === 'clamp') return 0;
  const alt = position.altitudeM;
  if (alt === undefined || !Number.isFinite(alt)) return 0;
  return Math.max(0, alt);
}

export function heightReferenceFor(cesium: Pick<CesiumLike, 'HeightReference'>, mode: HeightMode | undefined): number {
  switch (mode ?? 'clamp') {
    case 'absolute':
      return cesium.HeightReference.NONE;
    case 'relative':
      return cesium.HeightReference.RELATIVE_TO_GROUND;
    case 'clamp':
      return cesium.HeightReference.CLAMP_TO_GROUND;
  }
}

export function toCartesian(
  cesium: Pick<CesiumLike, 'Cartesian3'>,
  p: GeoPosition,
  mode: HeightMode | undefined,
): Cartesian3Like {
  return cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, heightFor(p, mode));
}

/** Flattened [lon, lat, height, ...] for `fromDegreesArrayHeights`. */
export function flattenPositions(positions: ReadonlyArray<GeoPosition>, mode: HeightMode | undefined): number[] {
  const out: number[] = [];
  for (const p of positions) out.push(p.longitude, p.latitude, heightFor(p, mode));
  return out;
}

export function toCartesianArray(
  cesium: Pick<CesiumLike, 'Cartesian3'>,
  positions: ReadonlyArray<GeoPosition>,
  mode: HeightMode | undefined,
): Cartesian3Like[] {
  return cesium.Cartesian3.fromDegreesArrayHeights(flattenPositions(positions, mode));
}

export function boundsToRectangle(cesium: Pick<CesiumLike, 'Rectangle'>, b: GeoBounds): RectangleLike {
  return cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
}

/** Every polyline/polygon vertex must be finite; Cesium throws on NaN. */
export function positionsValid(positions: ReadonlyArray<GeoPosition>): boolean {
  return (
    positions.length >= 2 &&
    positions.every(
      (p) =>
        Number.isFinite(p.latitude) &&
        Number.isFinite(p.longitude) &&
        Math.abs(p.latitude) <= 90 &&
        Math.abs(p.longitude) <= 180,
    )
  );
}
