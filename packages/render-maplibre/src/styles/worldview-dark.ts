import type { BasemapDescriptor } from '@worldview/render-core';
import type { Expr, LayerSpec, MapStyle } from './spec.js';

/**
 * WORLDVIEW basemap styles, written as typed objects for the Protomaps
 * "basemaps" tile schema (v4: layers earth, landuse, natural, water, buildings,
 * roads, transit, boundaries, places, pois, physical_line, physical_point; each
 * feature carries `kind`). Worldpacks are Protomaps extracts, so one style serves
 * offline PMTiles and an online PMTiles/tile URL alike. Restrained dark palette:
 * low-contrast land/water, roads by class, boundaries dashed, place labels only.
 */
export type StyleVariant = 'dark' | 'light';

export interface StylePalette {
  background: string;
  earth: string;
  water: string;
  waterLine: string;
  park: string;
  urban: string;
  industrial: string;
  building: string;
  highway: string;
  majorRoad: string;
  minorRoad: string;
  rail: string;
  boundary: string;
  regionBoundary: string;
  placeText: string;
  placeHalo: string;
  minorPlaceText: string;
  poiText: string;
  peakText: string;
}

export const DARK_PALETTE: StylePalette = {
  background: '#0b0f14',
  earth: '#151b23',
  water: '#0c1a26',
  waterLine: '#163247',
  park: '#17231d',
  urban: '#1a2028',
  industrial: '#1d2027',
  building: '#20272f',
  highway: '#3d4653',
  majorRoad: '#2f3843',
  minorRoad: '#242c36',
  rail: '#2a3340',
  boundary: '#4b5563',
  regionBoundary: '#374151',
  placeText: '#d1d5db',
  placeHalo: '#0b0f14',
  minorPlaceText: '#9ca3af',
  poiText: '#8b96a5',
  peakText: '#a3a9b3',
};

export const LIGHT_PALETTE: StylePalette = {
  background: '#e9ecef',
  earth: '#f3f4f6',
  water: '#c9dbe9',
  waterLine: '#a9c3d8',
  park: '#dcebd6',
  urban: '#e8e6e2',
  industrial: '#e3e1dd',
  building: '#d9d7d2',
  highway: '#f0b96b',
  majorRoad: '#ffffff',
  minorRoad: '#f7f7f5',
  rail: '#c8c4bd',
  boundary: '#8a8f98',
  regionBoundary: '#b1b5bd',
  placeText: '#1f2937',
  placeHalo: '#ffffff',
  minorPlaceText: '#4b5563',
  poiText: '#6b7280',
  peakText: '#4b5563',
};

export interface WorldviewStyleOptions {
  /** `pmtiles://<url-or-path>` or a tile-json url for the Protomaps basemap tiles. */
  sourceUrl: string;
  variant: StyleVariant;
  attribution: string;
  /** Glyph template url; the shell bundles fonts and serves them (offline-safe). */
  glyphs: string;
  fontStack?: string[];
  /** Language for place names (`name:<lang>` falls back to `name`). */
  language?: string;
  maxzoom?: number;
}

export const BASEMAP_SOURCE_ID = 'basemap';
export const DEFAULT_GLYPHS_URL = 'worldview://fonts/{fontstack}/{range}.pbf';
export const DEFAULT_FONT_STACK = ['Noto Sans Regular'];

const kindIn = (...kinds: string[]): Expr => ['in', ['get', 'kind'], ['literal', kinds]];
const kindIs = (kind: string): Expr => ['==', ['get', 'kind'], kind];
const nameExpr = (language: string): Expr => ['coalesce', ['get', `name:${language}`], ['get', 'name']];
const interpolate = (stops: Array<[number, number]>): Expr => ['interpolate', ['linear'], ['zoom'], ...stops.flat()];

export function buildWorldviewStyle(opts: WorldviewStyleOptions): MapStyle {
  const p = opts.variant === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const font = opts.fontStack ?? DEFAULT_FONT_STACK;
  const lang = opts.language ?? 'en';
  const src = BASEMAP_SOURCE_ID;
  const layers: LayerSpec[] = [
    { id: 'background', type: 'background', paint: { 'background-color': p.background } },
    { id: 'earth', type: 'fill', source: src, 'source-layer': 'earth', paint: { 'fill-color': p.earth } },
    {
      id: 'landuse-park',
      type: 'fill',
      source: src,
      'source-layer': 'landuse',
      filter: kindIn(
        'park',
        'forest',
        'nature_reserve',
        'wood',
        'golf_course',
        'cemetery',
        'grass',
        'garden',
        'protected_area',
        'national_park',
      ),
      paint: {
        'fill-color': p.park,
        'fill-opacity': interpolate([
          [6, 0.4],
          [12, 1],
        ]),
      },
    },
    {
      id: 'landuse-urban',
      type: 'fill',
      source: src,
      'source-layer': 'landuse',
      filter: kindIn(
        'residential',
        'commercial',
        'retail',
        'pedestrian',
        'school',
        'university',
        'college',
        'hospital',
      ),
      minzoom: 9,
      paint: {
        'fill-color': p.urban,
        'fill-opacity': interpolate([
          [9, 0],
          [12, 0.9],
        ]),
      },
    },
    {
      id: 'landuse-industrial',
      type: 'fill',
      source: src,
      'source-layer': 'landuse',
      filter: kindIn('industrial', 'railway', 'aerodrome', 'military', 'quarry', 'landfill'),
      minzoom: 9,
      paint: {
        'fill-color': p.industrial,
        'fill-opacity': interpolate([
          [9, 0],
          [12, 0.9],
        ]),
      },
    },
    {
      id: 'water',
      type: 'fill',
      source: src,
      'source-layer': 'water',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': p.water },
    },
    {
      id: 'water-line',
      type: 'line',
      source: src,
      'source-layer': 'water',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], kindIn('river', 'stream', 'canal', 'drain', 'ditch')],
      minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.waterLine,
        'line-width': interpolate([
          [8, 0.5],
          [14, 2],
        ]),
      },
    },
    {
      id: 'buildings',
      type: 'fill',
      source: src,
      'source-layer': 'buildings',
      minzoom: 13,
      paint: {
        'fill-color': p.building,
        'fill-opacity': interpolate([
          [13, 0],
          [15, 0.8],
        ]),
      },
    },
    {
      id: 'roads-rail',
      type: 'line',
      source: src,
      'source-layer': 'roads',
      filter: kindIs('rail'),
      minzoom: 9,
      paint: {
        'line-color': p.rail,
        'line-width': interpolate([
          [9, 0.5],
          [16, 2],
        ]),
        'line-dasharray': [4, 3],
      },
    },
    {
      id: 'roads-minor',
      type: 'line',
      source: src,
      'source-layer': 'roads',
      filter: kindIn('minor_road', 'other', 'path'),
      minzoom: 11,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.minorRoad,
        'line-width': interpolate([
          [11, 0.4],
          [16, 3],
        ]),
      },
    },
    {
      id: 'roads-medium',
      type: 'line',
      source: src,
      'source-layer': 'roads',
      filter: kindIs('medium_road'),
      minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.majorRoad,
        'line-width': interpolate([
          [8, 0.5],
          [16, 5],
        ]),
      },
    },
    {
      id: 'roads-major',
      type: 'line',
      source: src,
      'source-layer': 'roads',
      filter: kindIs('major_road'),
      minzoom: 6,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.majorRoad,
        'line-width': interpolate([
          [6, 0.5],
          [16, 7],
        ]),
      },
    },
    {
      id: 'roads-highway',
      type: 'line',
      source: src,
      'source-layer': 'roads',
      filter: kindIs('highway'),
      minzoom: 4,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.highway,
        'line-width': interpolate([
          [4, 0.4],
          [10, 1.5],
          [16, 9],
        ]),
      },
    },
    {
      id: 'boundaries-region',
      type: 'line',
      source: src,
      'source-layer': 'boundaries',
      filter: kindIn('region', 'county'),
      minzoom: 4,
      paint: {
        'line-color': p.regionBoundary,
        'line-width': interpolate([
          [4, 0.4],
          [10, 1],
        ]),
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'boundaries-country',
      type: 'line',
      source: src,
      'source-layer': 'boundaries',
      filter: kindIs('country'),
      paint: {
        'line-color': p.boundary,
        'line-width': interpolate([
          [2, 0.6],
          [10, 2],
        ]),
        'line-dasharray': [4, 2],
      },
    },
    {
      id: 'physical-peaks',
      type: 'symbol',
      source: src,
      'source-layer': 'physical_point',
      filter: kindIn('peak', 'volcano'),
      minzoom: 11,
      layout: {
        'text-field': nameExpr(lang),
        'text-font': font,
        'text-size': 10,
        'text-anchor': 'top',
        'text-offset': [0, 0.4],
        'text-optional': true,
      },
      paint: { 'text-color': p.peakText, 'text-halo-color': p.placeHalo, 'text-halo-width': 1 },
    },
    {
      id: 'pois',
      type: 'symbol',
      source: src,
      'source-layer': 'pois',
      filter: kindIn(
        'airport',
        'aerodrome',
        'station',
        'ferry_terminal',
        'harbour',
        'port',
        'hospital',
        'university',
        'stadium',
        'power_plant',
        'dam',
      ),
      minzoom: 12,
      layout: {
        'text-field': nameExpr(lang),
        'text-font': font,
        'text-size': 11,
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 20],
        'text-optional': true,
        'text-max-width': 8,
      },
      paint: { 'text-color': p.poiText, 'text-halo-color': p.placeHalo, 'text-halo-width': 1 },
    },
    {
      id: 'places-neighbourhood',
      type: 'symbol',
      source: src,
      'source-layer': 'places',
      filter: kindIn('neighbourhood', 'suburb', 'quarter'),
      minzoom: 12,
      layout: {
        'text-field': nameExpr(lang),
        'text-font': font,
        'text-size': 11,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
        'text-max-width': 9,
      },
      paint: { 'text-color': p.minorPlaceText, 'text-halo-color': p.placeHalo, 'text-halo-width': 1 },
    },
    {
      id: 'places-locality',
      type: 'symbol',
      source: src,
      'source-layer': 'places',
      filter: kindIs('locality'),
      minzoom: 5,
      layout: {
        'text-field': nameExpr(lang),
        'text-font': font,
        'text-size': interpolate([
          [5, 10],
          [12, 15],
        ]),
        'symbol-sort-key': ['coalesce', ['get', 'population_rank'], 0],
        'text-max-width': 8,
      },
      paint: { 'text-color': p.placeText, 'text-halo-color': p.placeHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'places-region',
      type: 'symbol',
      source: src,
      'source-layer': 'places',
      filter: kindIs('region'),
      minzoom: 3,
      maxzoom: 9,
      layout: {
        'text-field': nameExpr(lang),
        'text-font': font,
        'text-size': 11,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
      },
      paint: { 'text-color': p.minorPlaceText, 'text-halo-color': p.placeHalo, 'text-halo-width': 1 },
    },
    {
      id: 'places-country',
      type: 'symbol',
      source: src,
      'source-layer': 'places',
      filter: kindIs('country'),
      minzoom: 1,
      maxzoom: 7,
      layout: {
        'text-field': nameExpr(lang),
        'text-font': font,
        'text-size': interpolate([
          [1, 10],
          [6, 16],
        ]),
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.15,
      },
      paint: { 'text-color': p.placeText, 'text-halo-color': p.placeHalo, 'text-halo-width': 1.5 },
    },
  ];
  return {
    version: 8,
    name: `worldview-${opts.variant}`,
    metadata: { 'worldview:schema': 'protomaps-basemaps-v4', 'worldview:variant': opts.variant },
    glyphs: opts.glyphs,
    sources: {
      [src]: {
        type: 'vector',
        url: opts.sourceUrl,
        attribution: opts.attribution,
        ...(opts.maxzoom !== undefined ? { maxzoom: opts.maxzoom } : {}),
      },
    },
    layers,
  };
}

/** Raster XYZ basemap (Esri / user-configured / OSM as a non-default choice). */
export function buildRasterStyle(opts: {
  id: string;
  tiles: string[];
  tileSize?: number;
  maxzoom: number;
  attribution: string;
  variant?: StyleVariant;
}): MapStyle {
  const p = opts.variant === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  return {
    version: 8,
    name: `raster-${opts.id}`,
    sources: {
      [BASEMAP_SOURCE_ID]: {
        type: 'raster',
        tiles: opts.tiles,
        tileSize: opts.tileSize ?? 256,
        maxzoom: opts.maxzoom,
        attribution: opts.attribution,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': p.background } },
      { id: 'basemap-raster', type: 'raster', source: BASEMAP_SOURCE_ID, paint: { 'raster-fade-duration': 150 } },
    ],
  };
}

/** No basemap: a dark canvas so overlays remain legible offline without any pack. */
export function buildEmptyStyle(variant: StyleVariant = 'dark'): MapStyle {
  const p = variant === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  return {
    version: 8,
    name: `empty-${variant}`,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': p.background } }],
  };
}

/** Esri World Imagery tiles (conditional stack, never default; attribution is provider-mandated). */
export const ESRI_WORLD_IMAGERY_TILES = [
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
];
export const ESRI_ATTRIBUTION =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

export interface StyleBuildOptions {
  /** Esri World Imagery tile templates to use instead of Esri's own (the desktop tile cache). */
  esriTiles?: string[];
  variant?: StyleVariant;
  glyphs?: string;
  fontStack?: string[];
  language?: string;
}

/** Style for a contract BasemapDescriptor; `null` when the descriptor is a remote style url to hand to MapLibre directly. */
export function styleForBasemap(basemap: BasemapDescriptor, opts: StyleBuildOptions = {}): MapStyle | string {
  const variant = opts.variant ?? 'dark';
  const glyphs = opts.glyphs ?? DEFAULT_GLYPHS_URL;
  switch (basemap.kind) {
    case 'pmtiles':
      return buildWorldviewStyle({
        sourceUrl: basemap.url.startsWith('pmtiles://') ? basemap.url : `pmtiles://${basemap.url}`,
        variant: basemap.styleId === 'worldview-light' ? 'light' : 'dark',
        attribution: basemap.attribution,
        glyphs,
        ...(opts.fontStack ? { fontStack: opts.fontStack } : {}),
        ...(opts.language ? { language: opts.language } : {}),
      });
    case 'vector-style':
      return basemap.styleUrl;
    case 'raster-xyz':
      return buildRasterStyle({
        id: basemap.id,
        tiles: [basemap.url],
        maxzoom: basemap.maxZoom,
        attribution: basemap.attribution,
        variant,
        ...(basemap.tileSize !== undefined ? { tileSize: basemap.tileSize } : {}),
      });
    case 'esri-world-imagery':
      return buildRasterStyle({
        id: basemap.id,
        tiles: opts.esriTiles ?? ESRI_WORLD_IMAGERY_TILES,
        maxzoom: 19,
        attribution: basemap.attribution || ESRI_ATTRIBUTION,
        variant,
      });
    case 'none':
    case 'cesium-natural-earth':
    case 'cesium-ion':
      return buildEmptyStyle(variant);
  }
}
