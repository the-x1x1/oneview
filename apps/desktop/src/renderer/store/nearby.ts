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
