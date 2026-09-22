import type { PickResult, RenderFeature } from '@worldview/render-core';
import type { GeoPosition } from '@worldview/world-model';

/**
 * Picking: every primitive/entity this adapter creates carries the feature id
 * as its `id` (a string). `scene.pick` returns `{ id, primitive }` where `id` is
 * the string for primitives and the Entity (whose `.id` is the feature id) for
 * entities. Pure resolution so the mapping is testable without a scene.
 */
export function resolvePickedFeatureId(picked: unknown): string | undefined {
  if (!picked || typeof picked !== 'object') return undefined;
  const id = (picked as { id?: unknown }).id;
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object' && typeof (id as { id?: unknown }).id === 'string') return (id as { id: string }).id;
  return undefined;
}

/** Best position for a pick: the feature's own anchor when it has one, else the surface hit. */
export function pickAnchor(
  feature: RenderFeature | undefined,
  surface: GeoPosition | undefined,
): GeoPosition | undefined {
  if (feature) {
    const g = feature.geometry;
    if (g.kind === 'point' || g.kind === 'cluster') return g.position;
    if (g.kind === 'circle') return g.center;
  }
  return surface;
}

export function toPickResult(
  featureId: string,
  feature: RenderFeature | undefined,
  position: GeoPosition,
  screen: { x: number; y: number },
): PickResult {
  const result: PickResult = { featureId, position, screen };
  if (feature?.objectId) result.objectId = feature.objectId;
  if (feature?.eventId) result.eventId = feature.eventId;
  return result;
}
