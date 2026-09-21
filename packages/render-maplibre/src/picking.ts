import type { PickResult } from '@worldview/render-core';
import type { QueriedFeatureLike } from './maplibre-like.js';
import { OVERLAY_SOURCE_PREFIX } from './layers.js';

/**
 * queryRenderedFeatures → PickResult. Overlay features carry our `id` property;
 * MapLibre-generated clusters carry `cluster_id` and become a synthetic
 * `mlcluster:<source>:<id>` pick (no object id) so the shell can zoom into them.
 */
export function toPickResult(features: QueriedFeatureLike[], screen: { x: number; y: number }, lngLat: { lng: number; lat: number }): PickResult | null {
  for (const f of features) {
    if (!f.source.startsWith(OVERLAY_SOURCE_PREFIX)) continue;
    const p = f.properties;
    const position = pointOf(f) ?? { latitude: lngLat.lat, longitude: lngLat.lng };
    if (typeof p['cluster_id'] === 'number' && p['cluster'] === true) {
      return { featureId: `mlcluster:${f.source.slice(OVERLAY_SOURCE_PREFIX.length)}:${p['cluster_id']}`, position, screen };
    }
    if (typeof p['id'] !== 'string') continue;
    if (p['interactive'] === false) continue;
    const result: PickResult = { featureId: p['id'], position, screen };
    if (typeof p['objectId'] === 'string') result.objectId = p['objectId'];
    if (typeof p['eventId'] === 'string') result.eventId = p['eventId'];
    return result;
  }
  return null;
}

function pointOf(f: QueriedFeatureLike): { latitude: number; longitude: number; altitudeM?: number } | undefined {
  if (f.geometry.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) return undefined;
  const c = f.geometry.coordinates as number[];
  if (typeof c[0] !== 'number' || typeof c[1] !== 'number') return undefined;
  return c.length >= 3 && typeof c[2] === 'number' ? { latitude: c[1], longitude: c[0], altitudeM: c[2] } : { latitude: c[1], longitude: c[0] };
}
