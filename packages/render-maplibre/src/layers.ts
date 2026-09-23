import { themeEntry, type Theme } from '@worldview/render-core';
import type { ClusterOptions } from './sources.js';
import type { Expr, GeoJsonSource, LayerSpec } from './styles/spec.js';

/**
 * Overlay layer specs for one `RenderFeature.layer`: all in one GeoJSON source
 * (`wv:<layer>`) with kind filters, so a layer can mix points, lines, areas,
 * density cells and clusters. Pure; validated by the style tests.
 */
export const OVERLAY_SOURCE_PREFIX = 'wv:';
export const overlaySourceId = (layer: string): string => `${OVERLAY_SOURCE_PREFIX}${layer}`;

export interface OverlayLayerOptions {
  cluster?: ClusterOptions;
  fontStack: string[];
  theme?: Theme;
  labelFontPx?: number;
  /** The layer whose theme colour applies, when it is not `layer` (a companion of moving markers). */
  themeLayer?: string;
}

const kindIs = (kind: string): Expr => ['==', ['get', 'kind'], kind];
const hasIcon: Expr = ['!=', ['get', 'icon'], null];
const noIcon: Expr = ['==', ['get', 'icon'], null];
const hasLabel: Expr = ['!=', ['get', 'label'], null];
const isMapLibreCluster: Expr = ['has', 'point_count'];

export function overlaySource(layer: string, opts: OverlayLayerOptions): GeoJsonSource {
  const src: GeoJsonSource = {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    promoteId: 'id',
    tolerance: 0.2,
  };
  if (opts.cluster) {
    src.cluster = true;
    src.clusterRadius = opts.cluster.radiusPx;
    src.clusterMaxZoom = opts.cluster.maxZoom;
    src.clusterMinPoints = opts.cluster.minPoints ?? 3;
    // Keep one member colour so MapLibre-made clusters take the domain hue.
    src.clusterProperties = {
      color: [
        ['coalesce', ['accumulated'], ['get', 'color']],
        ['get', 'color'],
      ],
    };
  }
  return src;
}

/** Layer ids in draw order (density → areas → lines → points → icons → clusters → labels). */
export function overlayLayerIds(layer: string): string[] {
  return [
    'density',
    'fill',
    'outline',
    'line',
    'line-dashed',
    'circle',
    'symbol',
    'label',
    'cluster',
    'cluster-count',
  ].map((s) => `${overlaySourceId(layer)}:${s}`);
}

/** Layers whose features respond to picks. */
export function interactiveLayerIds(layer: string): string[] {
  return ['fill', 'line', 'line-dashed', 'circle', 'symbol', 'cluster'].map((s) => `${overlaySourceId(layer)}:${s}`);
}

export function overlayLayers(layer: string, opts: OverlayLayerOptions): LayerSpec[] {
  const source = overlaySourceId(layer);
  const id = (s: string) => `${source}:${s}`;
  const fontPx = opts.labelFontPx ?? 12;
  const layerColor = themeEntry(opts.themeLayer ?? layer, opts.theme).color;
  const halo = '#0b0f14';
  return [
    {
      id: id('density'),
      type: 'fill',
      source,
      filter: kindIs('density'),
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'], 'fill-antialias': false },
    },
    {
      id: id('fill'),
      type: 'fill',
      source,
      filter: ['any', kindIs('polygon'), kindIs('circle')],
      layout: { 'fill-sort-key': ['get', 'sortKey'] },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] },
    },
    {
      id: id('outline'),
      type: 'line',
      source,
      filter: ['any', kindIs('polygon'), kindIs('circle')],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['coalesce', ['get', 'strokeWidth'], 1],
        'line-opacity': ['get', 'opacity'],
      },
    },
    {
      id: id('line'),
      type: 'line',
      source,
      filter: ['all', kindIs('line'), ['==', ['get', 'lineStyle'], 'solid']],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sortKey'] },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'size'], 'line-opacity': ['get', 'opacity'] },
    },
    {
      id: id('line-dashed'),
      type: 'line',
      source,
      filter: ['all', kindIs('line'), ['!=', ['get', 'lineStyle'], 'solid']],
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sortKey'] },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['get', 'size'],
        'line-opacity': ['get', 'opacity'],
        'line-dasharray': [2, 2],
      },
    },
    {
      id: id('circle'),
      type: 'circle',
      source,
      filter: ['all', kindIs('point'), noIcon, ['!', isMapLibreCluster]],
      layout: { 'circle-sort-key': ['get', 'sortKey'] },
      paint: {
        'circle-radius': ['/', ['get', 'size'], 2],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'opacity'],
        'circle-stroke-color': ['get', 'strokeColor'],
        'circle-stroke-width': ['get', 'strokeWidth'],
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: id('symbol'),
      type: 'symbol',
      source,
      filter: ['all', kindIs('point'), hasIcon, ['!', isMapLibreCluster]],
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['/', ['*', ['get', 'size'], 2.2], 48],
        'icon-rotate': ['get', 'rotation'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': false,
        'icon-optional': false,
        'icon-anchor': 'center',
        'symbol-sort-key': ['get', 'sortKey'],
        'symbol-z-order': 'source',
        'text-field': ['coalesce', ['get', 'label'], ''],
        'text-font': opts.fontStack,
        'text-size': fontPx,
        'text-anchor': 'top',
        'text-offset': [0, 1.1],
        'text-optional': true,
        'text-allow-overlap': false,
        'text-max-width': 10,
      },
      paint: {
        'icon-opacity': ['get', 'opacity'],
        'text-color': '#e6edf3',
        'text-halo-color': halo,
        'text-halo-width': 1.2,
        'text-opacity': ['get', 'opacity'],
      },
    },
    {
      id: id('label'),
      type: 'symbol',
      source,
      filter: ['all', kindIs('point'), noIcon, hasLabel, ['!', isMapLibreCluster]],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': opts.fontStack,
        'text-size': fontPx,
        'text-anchor': 'top',
        'text-offset': [0, 0.8],
        'symbol-sort-key': ['get', 'sortKey'],
        'text-allow-overlap': false,
        'text-max-width': 10,
      },
      paint: {
        'text-color': '#e6edf3',
        'text-halo-color': halo,
        'text-halo-width': 1.2,
        'text-opacity': ['get', 'opacity'],
      },
    },
    {
      id: id('cluster'),
      type: 'circle',
      source,
      filter: ['any', isMapLibreCluster, kindIs('cluster')],
      paint: {
        'circle-radius': [
          'coalesce',
          ['/', ['get', 'size'], 2],
          ['+', 10, ['*', 2, ['log10', ['coalesce', ['get', 'point_count'], 1]]]],
        ],
        'circle-color': ['coalesce', ['get', 'color'], layerColor],
        'circle-opacity': 0.55,
        'circle-stroke-color': ['coalesce', ['get', 'color'], layerColor],
        'circle-stroke-width': 1.5,
        'circle-pitch-alignment': 'map',
      },
    },
    {
      id: id('cluster-count'),
      type: 'symbol',
      source,
      filter: ['any', isMapLibreCluster, kindIs('cluster')],
      layout: {
        'text-field': ['coalesce', ['get', 'point_count_abbreviated'], ['get', 'label'], ''],
        'text-font': opts.fontStack,
        'text-size': 11,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#0b0f14', 'text-opacity': 1 },
    },
  ];
}
