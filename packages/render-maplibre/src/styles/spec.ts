/**
 * Typed subset of the MapLibre style specification used by this adapter. Kept
 * as our own types so styles are validated (`validateStyle`) and generated as
 * plain objects; `toStyleSpecification` is the single conversion point to the
 * library's type.
 */
export type Expr = [string, ...unknown[]];
export type Value<T> = T | Expr;
export type Filter = Expr | boolean;

export interface VectorSource {
  type: 'vector';
  url?: string;
  tiles?: string[];
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
  volatile?: boolean;
}
export interface RasterSource {
  type: 'raster';
  tiles: string[];
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}
export interface GeoJsonSource {
  type: 'geojson';
  data: { type: 'FeatureCollection'; features: unknown[] };
  cluster?: boolean;
  clusterRadius?: number;
  clusterMaxZoom?: number;
  clusterMinPoints?: number;
  clusterProperties?: Record<string, [Expr, Expr]>;
  attribution?: string;
  tolerance?: number;
  buffer?: number;
  generateId?: boolean;
  promoteId?: string;
}
export type SourceSpec = VectorSource | RasterSource | GeoJsonSource;

interface LayerBase {
  id: string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: Filter;
  metadata?: Record<string, unknown>;
}
export interface BackgroundLayer extends LayerBase {
  type: 'background';
  paint: { 'background-color': Value<string>; 'background-opacity'?: Value<number> };
}
export interface FillLayer extends LayerBase {
  type: 'fill';
  source: string;
  layout?: { 'fill-sort-key'?: Value<number>; visibility?: 'visible' | 'none' };
  paint: {
    'fill-color': Value<string>;
    'fill-opacity'?: Value<number>;
    'fill-outline-color'?: Value<string>;
    'fill-antialias'?: Value<boolean>;
  };
}
export interface LineLayer extends LayerBase {
  type: 'line';
  source: string;
  layout?: {
    'line-cap'?: Value<'butt' | 'round' | 'square'>;
    'line-join'?: Value<'bevel' | 'round' | 'miter'>;
    'line-sort-key'?: Value<number>;
    visibility?: 'visible' | 'none';
  };
  paint: {
    'line-color': Value<string>;
    'line-width'?: Value<number>;
    'line-opacity'?: Value<number>;
    'line-dasharray'?: Value<number[]>;
    'line-blur'?: Value<number>;
  };
}
export interface SymbolLayer extends LayerBase {
  type: 'symbol';
  source: string;
  layout: {
    'symbol-placement'?: Value<'point' | 'line' | 'line-center'>;
    'symbol-sort-key'?: Value<number>;
    'symbol-z-order'?: Value<'auto' | 'viewport-y' | 'source'>;
    'icon-image'?: Value<string>;
    'icon-size'?: Value<number>;
    'icon-rotate'?: Value<number>;
    'icon-rotation-alignment'?: Value<'map' | 'viewport' | 'auto'>;
    'icon-allow-overlap'?: Value<boolean>;
    'icon-ignore-placement'?: Value<boolean>;
    'icon-anchor'?: Value<'center' | 'left' | 'right' | 'top' | 'bottom'>;
    'icon-optional'?: Value<boolean>;
    'text-field'?: Value<string>;
    'text-font'?: Value<string[]>;
    'text-size'?: Value<number>;
    'text-anchor'?: Value<'center' | 'left' | 'right' | 'top' | 'bottom'>;
    'text-offset'?: Value<[number, number]>;
    'text-allow-overlap'?: Value<boolean>;
    'text-ignore-placement'?: Value<boolean>;
    'text-optional'?: Value<boolean>;
    'text-max-width'?: Value<number>;
    'text-transform'?: Value<'none' | 'uppercase' | 'lowercase'>;
    'text-letter-spacing'?: Value<number>;
    'text-padding'?: Value<number>;
    visibility?: 'visible' | 'none';
  };
  paint?: {
    'icon-opacity'?: Value<number>;
    'icon-color'?: Value<string>;
    'text-opacity'?: Value<number>;
    'text-color'?: Value<string>;
    'text-halo-color'?: Value<string>;
    'text-halo-width'?: Value<number>;
    'text-halo-blur'?: Value<number>;
  };
}
export interface CircleLayer extends LayerBase {
  type: 'circle';
  source: string;
  layout?: { 'circle-sort-key'?: Value<number>; visibility?: 'visible' | 'none' };
  paint: {
    'circle-radius': Value<number>;
    'circle-color': Value<string>;
    'circle-opacity'?: Value<number>;
    'circle-blur'?: Value<number>;
    'circle-stroke-width'?: Value<number>;
    'circle-stroke-color'?: Value<string>;
    'circle-stroke-opacity'?: Value<number>;
    'circle-pitch-alignment'?: Value<'map' | 'viewport'>;
  };
}
export interface HeatmapLayer extends LayerBase {
  type: 'heatmap';
  source: string;
  paint: {
    'heatmap-radius'?: Value<number>;
    'heatmap-weight'?: Value<number>;
    'heatmap-intensity'?: Value<number>;
    'heatmap-color'?: Expr;
    'heatmap-opacity'?: Value<number>;
  };
}
export interface RasterLayer extends LayerBase {
  type: 'raster';
  source: string;
  paint?: {
    'raster-opacity'?: Value<number>;
    'raster-saturation'?: Value<number>;
    'raster-brightness-min'?: Value<number>;
    'raster-brightness-max'?: Value<number>;
    'raster-contrast'?: Value<number>;
    'raster-fade-duration'?: Value<number>;
  };
}
export type LayerSpec =
  | BackgroundLayer
  | FillLayer
  | LineLayer
  | SymbolLayer
  | CircleLayer
  | HeatmapLayer
  | RasterLayer;

export interface MapStyle {
  version: 8;
  name: string;
  metadata?: Record<string, unknown>;
  glyphs?: string;
  sprite?: string;
  sources: Record<string, SourceSpec>;
  layers: LayerSpec[];
  transition?: { duration?: number; delay?: number };
}

export interface StyleProblem {
  layer?: string;
  message: string;
}

/** Structural validation independent of MapLibre: unique ids, referenced sources exist, vector layers name a source-layer, text needs glyphs. */
export function validateStyle(style: MapStyle): StyleProblem[] {
  const problems: StyleProblem[] = [];
  const ids = new Set<string>();
  for (const layer of style.layers) {
    if (ids.has(layer.id)) problems.push({ layer: layer.id, message: 'duplicate layer id' });
    ids.add(layer.id);
    if (layer.type === 'background') continue;
    const source = style.sources[layer.source];
    if (!source) {
      problems.push({ layer: layer.id, message: `unknown source "${layer.source}"` });
      continue;
    }
    if (source.type === 'vector' && !layer['source-layer'])
      problems.push({ layer: layer.id, message: 'vector layer without source-layer' });
    if (source.type !== 'vector' && layer['source-layer'])
      problems.push({ layer: layer.id, message: 'source-layer on a non-vector source' });
    if (source.type === 'raster' && layer.type !== 'raster')
      problems.push({ layer: layer.id, message: 'raster source used by a non-raster layer' });
    if (layer.type === 'symbol' && layer.layout['text-field'] !== undefined && !style.glyphs)
      problems.push({ layer: layer.id, message: 'text layer but the style has no glyphs url' });
  }
  for (const [id, src] of Object.entries(style.sources)) {
    if (src.type === 'vector' && !src.url && !src.tiles)
      problems.push({ message: `vector source "${id}" has neither url nor tiles` });
    if (src.type === 'raster' && src.tiles.length === 0)
      problems.push({ message: `raster source "${id}" has no tiles` });
  }
  return problems;
}
