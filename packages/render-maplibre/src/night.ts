import { NIGHT_BANDS_DEG, nightRing, subsolarPoint } from '@worldview/render-core';
import type { FillLayer, GeoJsonSource } from './styles/spec.js';

/**
 * Day and night in 2D: the night side as filled polygons (render-core sun.ts), above the
 * basemap and raster overlays and below the borders, names and every marker.
 *
 * One polygon per band — the Sun below the horizon, and below −6°, −12° and −18° (the ends
 * of civil, nautical and astronomical twilight) — each filled with the same faint dark
 * blue. Where they overlap they stack, so the shade deepens from the terminator to full night
 * over some 2,000 km rather than stepping once at the line, and the deepest night still lets
 * the map through: this is shading on a map, not a curtain over it.
 *
 * Four fills of one small source cost next to nothing to draw, and the source is rewritten
 * once a minute (DAY_NIGHT_REFRESH_MS).
 */
export const NIGHT_SOURCE = 'wv-night';
export const NIGHT_LAYER_IDS: readonly string[] = NIGHT_BANDS_DEG.map((_, i) => `wv-night:${i}`);

/** Per band; four of them over the deepest night come to ~0.43. */
const BAND_OPACITY = 0.13;
const NIGHT_COLOR = '#020818';

export interface NightCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: number;
    geometry: { type: 'Polygon'; coordinates: Array<Array<[number, number]>> };
    properties: { band: number };
  }>;
}

export function nightCollection(nowMs: number): NightCollection {
  const sun = subsolarPoint(nowMs);
  return {
    type: 'FeatureCollection',
    features: NIGHT_BANDS_DEG.map((elevation, band) => ({
      type: 'Feature' as const,
      id: band,
      geometry: { type: 'Polygon' as const, coordinates: [nightRing(nowMs, elevation, 180, sun)] },
      properties: { band },
    })),
  };
}

export function nightSource(nowMs: number): GeoJsonSource {
  // No simplification: the ring is already sparse, and simplifying it at low zoom would pull
  // the terminator off the line the globe draws.
  return { type: 'geojson', data: nightCollection(nowMs), tolerance: 0 };
}

export function nightLayers(): FillLayer[] {
  return NIGHT_LAYER_IDS.map((id, band) => ({
    id,
    type: 'fill',
    source: NIGHT_SOURCE,
    filter: ['==', ['get', 'band'], band],
    paint: { 'fill-color': NIGHT_COLOR, 'fill-opacity': BAND_OPACITY, 'fill-antialias': false },
  }));
}
