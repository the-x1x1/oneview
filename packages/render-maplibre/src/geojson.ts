import type { RenderFeature } from '@worldview/render-core';
import { resolveStyle, type ResolvedStyle, type Theme } from '@worldview/render-core';
import type { GeoBounds, GeoPosition } from '@worldview/world-model';

/**
 * GeoJSON shapes (subset of RFC 7946 / @types/geojson) and the RenderFeature →
 * GeoJSON feature conversion. Properties are flat primitives so MapLibre
 * expressions (`['get', ...]`) can drive paint/layout without feature-state.
 */
export type Position = number[];
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'Polygon'; coordinates: Position[][] };

export type FeaturePropertyValue = string | number | boolean | null;

export interface OverlayProperties {
  [name: string]: FeaturePropertyValue;
  id: string;
  objectId: string | null;
  eventId: string | null;
  kind: 'point' | 'line' | 'polygon' | 'circle' | 'cluster' | 'density';
  styleClass: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fillOpacity: number;
  opacity: number;
  size: number;
  icon: string | null;
  rotation: number;
  label: string | null;
  /** MapLibre sorts ascending: lower renders/places first, so this is −priority. */
  sortKey: number;
  priority: number;
  interactive: boolean;
  selected: boolean;
  lineStyle: 'solid' | 'dashed' | 'trail';
  count: number;
  intensity: number;
}

export interface GeoJsonFeature { type: 'Feature'; id?: string | number; geometry: GeoJsonGeometry; properties: OverlayProperties }
export interface GeoJsonFeatureCollection { type: 'FeatureCollection'; features: GeoJsonFeature[] }

export const EMPTY_COLLECTION: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };

const toPos = (p: GeoPosition): Position => (p.altitudeM !== undefined ? [p.longitude, p.latitude, p.altitudeM] : [p.longitude, p.latitude]);

export function boundsToRing(b: GeoBounds): Position[] {
  return [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
}

/** Geodesic circle approximated with `segments` vertices (closed ring). */
export function circleRing(center: GeoPosition, radiusM: number, segments = 48): Position[] {
  const R = 6_371_008.8;
  const lat = (center.latitude * Math.PI) / 180, lon = (center.longitude * Math.PI) / 180, d = radiusM / R;
  const ring: Position[] = [];
  for (let i = 0; i <= segments; i++) {
    const brg = (i / segments) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
    const lon2 = lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}

export function featureGeometry(f: RenderFeature): GeoJsonGeometry | undefined {
  const g = f.geometry;
  switch (g.kind) {
    case 'point': return { type: 'Point', coordinates: toPos(g.position) };
    case 'cluster': return { type: 'Point', coordinates: toPos(g.position) };
    case 'line': return g.positions.length >= 2 ? { type: 'LineString', coordinates: g.positions.map(toPos) } : undefined;
    case 'polygon': return g.rings.length && (g.rings[0]?.length ?? 0) >= 3 ? { type: 'Polygon', coordinates: g.rings.map((r) => r.map(toPos)) } : undefined;
    case 'circle': return Number.isFinite(g.radiusM) && g.radiusM > 0 ? { type: 'Polygon', coordinates: [circleRing(g.center, g.radiusM)] } : undefined;
    case 'density': return { type: 'Polygon', coordinates: [boundsToRing(g.bounds)] };
  }
}

/** Icon image id: icon + colour, matching `IconRegistry.ensure`. */
export function iconImageId(icon: string, colorCss: string): string {
  return `wv-icon:${icon}:${colorCss}`;
}

export function toOverlayFeature(f: RenderFeature, theme?: Theme): GeoJsonFeature | undefined {
  const geometry = featureGeometry(f);
  if (!geometry) return undefined;
  const resolved: ResolvedStyle = resolveStyle(f.style, theme);
  const kind = f.geometry.kind;
  const strokeCss = rgba(resolved.outlineColor);
  const properties: OverlayProperties = {
    id: f.id,
    objectId: f.objectId ?? null,
    eventId: f.eventId ?? null,
    kind,
    styleClass: f.style.styleClass,
    color: resolved.colorCss,
    strokeColor: strokeCss,
    strokeWidth: resolved.outlineWidthPx,
    fillOpacity: kind === 'density' ? 0.12 + 0.6 * clamp01(f.geometry.kind === 'density' ? f.geometry.intensity : 0) * resolved.opacity : resolved.fillAlpha,
    opacity: resolved.opacity,
    size: resolved.sizePx,
    icon: resolved.icon ? iconImageId(resolved.icon, resolved.colorCss) : null,
    rotation: resolved.rotationDegrees,
    label: f.style.label ?? null,
    sortKey: -(f.style.labelPriority ?? f.priority),
    priority: f.priority,
    interactive: f.interactive,
    selected: f.style.selected ?? false,
    lineStyle: f.style.lineStyle ?? 'solid',
    count: f.geometry.kind === 'cluster' || f.geometry.kind === 'density' ? f.geometry.count : 1,
    intensity: f.geometry.kind === 'density' ? f.geometry.intensity : 0,
  };
  return { type: 'Feature', id: f.id, geometry, properties };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
function rgba(c: { r: number; g: number; b: number; a: number }): string {
  const ch = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},${Math.max(0, Math.min(1, c.a)).toFixed(3)})`;
}
