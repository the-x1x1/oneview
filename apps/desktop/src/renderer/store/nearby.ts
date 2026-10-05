import { haversineMeters, type GeoBounds, type GeoPosition, type WorldObject } from '@worldview/world-model';

/** How many objects the keyboard steps through: the nearest this many to the middle. */
export const NEARBY_MAX = 300;

function inBounds(p: GeoPosition, b: GeoBounds): boolean {
  if (p.latitude < b.south || p.latitude > b.north) return false;
  // Bounds across the antimeridian run west > east.
  return b.west <= b.east
    ? p.longitude >= b.west && p.longitude <= b.east
    : p.longitude >= b.west || p.longitude <= b.east;
}

const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * The view's bounds as the keyboard should use them. The flat map clamps its bounds to
 * ±180° and reports its centre unwrapped (185° after a drag east), so a view across the
 * antimeridian arrives as 170..180 with the objects at −175° outside it: rebuilt round the
 * centre from the side that was not clamped, west > east across 180°. Clamped on both sides,
 * the view is the whole width of the world: undefined (no longitude limit).
 */
export function keyboardBounds(center: GeoPosition, bounds: GeoBounds | undefined): GeoBounds | undefined {
  if (!bounds) return undefined;
  const c = center.longitude;
  const westClamped = bounds.west <= -180;
  const eastClamped = bounds.east >= 180;
  if (!westClamped && !eastClamped && c >= -180 && c <= 180) return bounds;
  if (westClamped && eastClamped) return { ...bounds, west: -180, east: 180 };
  const half = eastClamped ? c - bounds.west : bounds.east - c;
  if (!(half > 0) || half >= 180) return { ...bounds, west: -180, east: 180 };
  return { ...bounds, west: wrap(c - half), east: wrap(c + half) };
}

/**
 * The objects in view as the keyboard meets them (`]` and `[`): those with a position inside
 * `bounds` (all, when the view has none), nearest to `middle` first, ties by id; ids only.
 */
export function nearbyOrder(
  objects: Iterable<Pick<WorldObject, 'id' | 'position'>>,
  middle: GeoPosition,
  bounds: GeoBounds | undefined,
): string[] {
  const near: Array<{ id: string; d: number }> = [];
  for (const o of objects) {
    const p = o.position;
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    if (bounds && !inBounds(p, bounds)) continue;
    near.push({ id: o.id, d: haversineMeters(middle, p) });
  }
  near.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return near.slice(0, NEARBY_MAX).map((n) => n.id);
}
