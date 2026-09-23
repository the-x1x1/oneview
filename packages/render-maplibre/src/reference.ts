import {
  referenceLabelsGeoJSON,
  referenceLinesGeoJSON,
  type ReferenceData,
  type ReferenceOptions,
} from '@worldview/render-core';
import type { Expr, GeoJsonSource, LayerSpec } from './styles/spec.js';
import { MAPLIBRE_ZOOM_OFFSET } from './view.js';

/**
 * Borders and names in 2D: two GeoJSON sources under the world's own layers. Natural
 * Earth's zoom thresholds are in the shared 256-px convention, one above MapLibre's own
 * (view.ts), so every threshold is shifted by MAPLIBRE_ZOOM_OFFSET. Names are symbol
 * layers, so MapLibre's collision detection keeps them from overlapping each other.
 */
export const REFERENCE_LINES_SOURCE = 'wv-ref:lines';
export const REFERENCE_LABELS_SOURCE = 'wv-ref:labels';

const mlZoom = (key: string): Expr => ['-', ['get', key], MAPLIBRE_ZOOM_OFFSET];
const kindIs = (kind: string): Expr => ['==', ['get', 'kind'], kind];
const dashedIs = (dashed: boolean): Expr => ['==', ['get', 'dashed'], dashed];
const drawnFrom: Expr = ['>=', ['zoom'], mlZoom('minZoom')];

export function referenceSources(data: ReferenceData): Record<string, GeoJsonSource> {
  return {
    [REFERENCE_LINES_SOURCE]: { type: 'geojson', data: referenceLinesGeoJSON(data.lines), tolerance: 0.4 },
    [REFERENCE_LABELS_SOURCE]: { type: 'geojson', data: referenceLabelsGeoJSON(data.labels) },
  };
}

/** Layer specs, bottom to top. Only what the options switch on. */
export function referenceLayers(options: ReferenceOptions, fontStack: string[]): LayerSpec[] {
  const layers: LayerSpec[] = [];
  if (options.borders) {
    const line = (
      id: string,
      kind: string,
      dashed: boolean,
      color: string,
      width: number,
      under: boolean,
    ): LayerSpec => ({
      id,
      type: 'line',
      source: REFERENCE_LINES_SOURCE,
      filter: ['all', kindIs(kind), dashedIs(dashed), drawnFrom],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': color,
        'line-width': width,
        ...(dashed && !under ? { 'line-dasharray': [3, 2] } : {}),
      },
    });
    for (const dashed of [false, true]) {
      layers.push(line(`wv-ref:state-under${dashed ? '-dashed' : ''}`, 'state', dashed, 'rgba(0,0,0,0.18)', 1.9, true));
      layers.push(
        line(`wv-ref:state${dashed ? '-dashed' : ''}`, 'state', dashed, 'rgba(255,255,255,0.32)', 0.8, false),
      );
    }
    for (const dashed of [false, true]) {
      layers.push(
        line(`wv-ref:country-under${dashed ? '-dashed' : ''}`, 'country', dashed, 'rgba(0,0,0,0.30)', 2.4, true),
      );
      layers.push(
        line(`wv-ref:country${dashed ? '-dashed' : ''}`, 'country', dashed, 'rgba(255,255,255,0.55)', 1.1, false),
      );
    }
  }
  if (options.labels) {
    const label = (id: string, kind: string, size: number, color: string): LayerSpec => ({
      id,
      type: 'symbol',
      source: REFERENCE_LABELS_SOURCE,
      filter: ['all', kindIs(kind), drawnFrom, ['<=', ['zoom'], mlZoom('maxZoom')]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': fontStack,
        'text-size': size,
        'text-max-width': 8,
        'text-padding': 4,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: {
        'text-color': color,
        'text-halo-color': 'rgba(0,0,0,0.6)',
        'text-halo-width': 1.2,
      },
    });
    layers.push(label('wv-ref:labels-state', 'state', 10.5, 'rgba(230,237,247,0.62)'));
    layers.push(label('wv-ref:labels-country', 'country', 13, 'rgba(255,255,255,0.85)'));
  }
  return layers;
}

/** Every reference layer id that can exist, for removal. */
export const REFERENCE_LAYER_IDS: readonly string[] = referenceLayers({ borders: true, labels: true }, ['x']).map(
  (l) => l.id,
);
