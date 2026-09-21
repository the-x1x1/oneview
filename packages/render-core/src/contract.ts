import type { GeoBounds, GeoPosition, WorldGeometry, FreshnessClass } from '@worldview/world-model';

/**
 * World rendering contract (architecture-contract-v1).
 *
 * Renderers (Cesium, MapLibre, dense) consume presentation-ready RenderFeatures.
 * They never see providers, observations or raw payloads. The presentation
 * pipeline in this package turns WorldObjects/WorldEvents into RenderFeatures
 * using lens rendering rules and level-of-detail rules.
 */
export type RenderGeometry =
  | { kind: 'point'; position: GeoPosition }
  | { kind: 'line'; positions: GeoPosition[] }
  | { kind: 'polygon'; rings: GeoPosition[][] }
  | { kind: 'circle'; center: GeoPosition; radiusM: number }
  | { kind: 'cluster'; position: GeoPosition; count: number; bounds: GeoBounds }
  | { kind: 'density'; bounds: GeoBounds; count: number; intensity: number };

export interface RenderStyle {
  /** Semantic style class resolved by the renderer's theme (e.g. "aircraft", "earthquake.major"). */
  styleClass: string;
  /** Hex colour override (theme decides default). */
  color?: string;
  /** Point size in px / line width in px. */
  size?: number;
  opacity?: number;
  /** Icon id from the shared icon set (renderer maps it to a billboard/sprite). */
  icon?: string;
  /** Rotation for oriented icons (heading), degrees clockwise from north. */
  rotationDegrees?: number;
  label?: string;
  labelPriority?: number;
  /** Visual state hints. */
  selected?: boolean;
  hovered?: boolean;
  freshness?: FreshnessClass;
  /** Height reference for 3D renderers. */
  heightMode?: 'clamp' | 'absolute' | 'relative';
  /** Dashed/animated line variants. */
  lineStyle?: 'solid' | 'dashed' | 'trail';
}

export interface RenderFeature {
  id: string;
  objectId?: string;
  eventId?: string;
  geometry: RenderGeometry;
  style: RenderStyle;
  interactive: boolean;
  /** Higher renders on top / wins label collisions. */
  priority: number;
  /** Time the feature is valid for (replay/timeline). */
  validAt?: string;
  /** Layer grouping for renderer batching (one primitive collection per layer). */
  layer: string;
}

/** Camera/viewport state shared between 2D and 3D renderers (directive §49). */
export interface ViewState {
  center: GeoPosition;
  /** Approximate camera altitude in metres above the ellipsoid (3D) — derived from zoom for 2D. */
  altitudeM: number;
  /** Web-Mercator zoom level (2D) — derived from altitude for 3D. */
  zoom: number;
  headingDegrees: number;
  pitchDegrees: number;
  bounds?: GeoBounds;
}

export type RenderMode = '2D' | '3D' | 'AUTO';

export interface RendererCapabilities {
  mode: '2D' | '3D';
  terrain: boolean;
  tilt: boolean;
  clustering: boolean;
  maxFeatures: number;
}

export interface FeatureUpdate {
  upsert: RenderFeature[];
  remove: string[];
  /** When true the renderer should replace all features in the given layers. */
  replaceLayers?: string[];
}

export interface PickResult {
  featureId: string;
  objectId?: string;
  eventId?: string;
  position: GeoPosition;
  screen: { x: number; y: number };
}

export interface AttributionEntry {
  id: string;
  text: string;
  url?: string;
  onScreen: boolean;
}

export interface RendererEvents {
  viewChanged: ViewState;
  pick: PickResult | null;
  hover: PickResult | null;
  ready: void;
  error: { message: string; fatal: boolean };
  frame: { fps: number; featureCount: number };
}

/**
 * WorldRenderer — the single interface both adapters implement. Imperative; owned by
 * the render layer, driven by the presentation pipeline and the React shell.
 */
export interface WorldRenderer {
  readonly capabilities: RendererCapabilities;
  mount(container: HTMLElement): Promise<void>;
  unmount(): void;
  /** Suspend rendering while hidden (directive §49): release GPU work but keep state. */
  suspend(): void;
  resume(): void;
  update(update: FeatureUpdate): void;
  clear(layer?: string): void;
  setView(view: Partial<ViewState>, opts?: { animate?: boolean; durationMs?: number }): void;
  getView(): ViewState;
  flyTo(target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds }, opts?: { durationMs?: number }): Promise<void>;
  select(featureId: string | null): void;
  setAttribution(entries: AttributionEntry[]): void;
  setBasemap(basemap: BasemapDescriptor): Promise<void>;
  on<K extends keyof RendererEvents>(event: K, listener: (payload: RendererEvents[K]) => void): () => void;
  /** Screenshot as PNG bytes (export). */
  screenshot?(): Promise<Uint8Array>;
  dispose(): void;
}

/** Basemap/terrain descriptors — providers of map tiles are configured through the map-provider registry, never hardcoded in renderers. */
export type BasemapDescriptor =
  | { kind: 'raster-xyz'; id: string; url: string; attribution: string; maxZoom: number; tileSize?: number }
  | { kind: 'vector-style'; id: string; styleUrl: string; attribution: string }
  | { kind: 'pmtiles'; id: string; url: string; styleId: 'worldview-dark' | 'worldview-light'; attribution: string }
  | { kind: 'cesium-natural-earth'; id: string; attribution: string }
  | { kind: 'cesium-ion'; id: string; assetId: number; attribution: string }
  | { kind: 'esri-world-imagery'; id: string; attribution: string }
  | { kind: 'none'; id: string };

export type TerrainDescriptor =
  | { kind: 'ellipsoid' }
  | { kind: 'cesium-ion-world-terrain' }
  | { kind: 'quantized-mesh'; url: string; attribution: string }
  | { kind: 'local'; path: string; attribution: string };

export function positionToGeometry(p: GeoPosition): RenderGeometry {
  return { kind: 'point', position: p };
}

export function worldGeometryToRender(g: WorldGeometry): RenderGeometry | undefined {
  const toPos = (c: [number, number] | [number, number, number]): GeoPosition => (c.length === 3 ? { latitude: c[1], longitude: c[0], altitudeM: c[2] } : { latitude: c[1], longitude: c[0] });
  switch (g.type) {
    case 'Point': return { kind: 'point', position: toPos(g.coordinates) };
    case 'LineString': return { kind: 'line', positions: g.coordinates.map(toPos) };
    case 'Polygon': return { kind: 'polygon', rings: g.coordinates.map((r) => r.map(toPos)) };
    case 'MultiPoint': return g.coordinates.length ? { kind: 'point', position: toPos(g.coordinates[0]!) } : undefined;
    case 'MultiLineString': return { kind: 'line', positions: g.coordinates.flat().map(toPos) };
    case 'MultiPolygon': return g.coordinates.length ? { kind: 'polygon', rings: g.coordinates[0]!.map((r) => r.map(toPos)) } : undefined;
  }
}

/** Zoom ↔ altitude conversion shared by both renderers (web-mercator at the equator, 256px tiles, ~60° FOV). */
export function zoomToAltitudeM(zoom: number, latitude = 0): number {
  const metersPerPixel = (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  // Viewport of ~1024px wide at 60° fov: altitude ≈ half-width / tan(30°)
  return Math.max(10, (metersPerPixel * 512) / Math.tan(Math.PI / 6));
}

export function altitudeToZoom(altitudeM: number, latitude = 0): number {
  const metersPerPixel = (altitudeM * Math.tan(Math.PI / 6)) / 512;
  const z = Math.log2((156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / metersPerPixel);
  return Math.max(0, Math.min(22, z));
}
