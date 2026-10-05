import { geometryCentroid, type GeoPosition } from '@worldview/world-model';
import type { FeatureUpdate, RenderFeature } from '@worldview/render-core';

/**
 * Map tools that draw features of their own — the latitude and longitude grid, range rings —
 * beside the presentation pass rather than through it (map-host.tsx). Each keeps what it last
 * sent: the host it went to, a key for what it showed, and the feature ids, so it sends nothing
 * while the key stays the same and removes exactly its own features when it changes.
 */
export interface ToolLayerShown {
  host: unknown;
  key: string;
  ids: string[];
}

export const NO_TOOL_LAYER: ToolLayerShown = Object.freeze({ host: null, key: '', ids: [] }) as ToolLayerShown;

/**
 * Send a tool's features for `key` (empty: none) unless that is what the host already shows.
 * A different host (one built again) has none of them, so everything is sent again.
 */
export function sendToolLayer(
  host: { setFeatures?(update: FeatureUpdate): void },
  shown: { current: ToolLayerShown },
  key: string,
  build: () => RenderFeature[],
): boolean {
  if (!host.setFeatures) return false;
  if (shown.current.host !== host) shown.current = { host, key: '', ids: [] };
  if (key === shown.current.key) return false;
  const features = key ? build() : [];
  const keep = new Set(features.map((f) => f.id));
  host.setFeatures({ upsert: features, remove: shown.current.ids.filter((id) => !keep.has(id)) });
  shown.current = { host, key, ids: [...keep] };
  return true;
}

/** Where the selection is: an object's position, or the middle of an event's geometry. */
export function selectionPosition(world: {
  selectedId: string | null;
  selectedKind?: 'object' | 'event' | null;
  objects: ReadonlyMap<string, { position?: GeoPosition }>;
  events: ReadonlyMap<string, { geometry?: Parameters<typeof geometryCentroid>[0] }>;
}): GeoPosition | undefined {
  const id = world.selectedId;
  if (!id) return undefined;
  if (world.selectedKind !== 'event') {
    const p = world.objects.get(id)?.position;
    if (p) return p;
  }
  const g = world.events.get(id)?.geometry;
  return g ? geometryCentroid(g) : undefined;
}
