import type { GeoBounds, GeoPosition, GeoRegion, WorldEvent, WorldObject } from '@worldview/world-model';
import { boundsContain, circleBounds } from '@worldview/world-model';
import type { FeatureUpdate, RenderFeature, RenderGeometry, RenderMotion, RenderStyle, ViewState } from './contract.js';
import { worldGeometryToRender } from './contract.js';

/**
 * Presentation pipeline: WorldObject/WorldEvent → RenderFeature with level-of-detail
 * (directive §50) and lens rendering rules (§56). Pure functions; runs on the UI
 * thread for small sets and in a worker for large ones (the worker just calls
 * `presentObjects`).
 */
export type LodBand = 'global' | 'continental' | 'regional' | 'local';

export function lodBand(zoom: number): LodBand {
  if (zoom < 3) return 'global';
  if (zoom < 6) return 'continental';
  if (zoom < 10) return 'regional';
  return 'local';
}

export type LodMode = 'hidden' | 'density' | 'points' | 'markers' | 'icons';

/**
 * How much of each rule the presenter is allowed to honour, set by the performance
 * governor from measured frame rate (see `performance.ts`).
 *
 *   0 — full:    every rule's authored mode for the band.
 *   1 — reduced: icons become markers (no sprite, no label).
 *   2 — minimal: icons and markers become bare points.
 *
 * No level hides, groups or aggregates anything. Every object stays its own dot at every
 * level; what a slow machine gives up is the cost *per* dot — sprites, labels, rotation —
 * never the dot. An earlier ladder ended in density cells, and a heatmap over the overview
 * is exactly what an operator does not want: it answers "roughly how many" and refuses to
 * say "where, exactly, is each one".
 */
export type DetailLevel = 0 | 1 | 2;

/** Density cell size to fall back on when a rule is aggregated at a band it never declared. */
const DENSITY_FALLBACK_CELL_DEG: Record<LodBand, number> = {
  global: 5,
  continental: 2,
  regional: 0.5,
  local: 0.1,
};

/** Cluster cells grow with detail pressure, so a crowd costs one bubble instead of ten. */
const CLUSTER_SCALE: Record<DetailLevel, number> = { 0: 1, 1: 1.8, 2: 3 };

/**
 * The mode a rule actually renders in, after the governor's detail level is applied. Only
 * ever makes a mode cheaper per object; never turns objects into a count.
 */
export function effectiveMode(rule: RenderingRule, band: LodBand, detail: DetailLevel): LodMode {
  const authored = rule.lod[band];
  if (detail <= 0 || authored === 'hidden' || authored === 'density' || authored === 'points') return authored;
  if (detail === 1) return authored === 'icons' ? 'markers' : authored;
  return 'points';
}

export interface RenderingRule {
  objectTypes: string[];
  /** Mode per LOD band. */
  lod: Record<LodBand, LodMode>;
  styleClass: string;
  icon?: string;
  /** Property used to scale size (e.g. magnitude). */
  sizeBy?: { property: string; min: number; max: number; scale: [number, number] };
  /** Property used for categorical/gradient colour (renderer theme resolves the class suffix). */
  colorBy?: { property: string; bands: Array<{ upTo: number; suffix: string }> };
  basePriority: number;
  /** Aggregate cell size in degrees per band when mode is 'density'. */
  densityCellDeg?: Partial<Record<LodBand, number>>;
  /** Cluster distance in px when mode is 'points'/'markers' (0 = no clustering). */
  clusterPx?: number;
  /**
   * Diameter in px of this type's dot in 'points' mode (default 4) and in 'markers' mode
   * (default 7). Sizes are per type so the kinds read apart at a glance on the overview —
   * aircraft over the satellites they share the sky with — rather than one uniform 3 px
   * speck for everything.
   */
  pointPx?: number;
  markerPx?: number;
}

/**
 * Rendering rules, best-first by band.
 *
 * Every object is its own point at every band, and nothing is grouped. The `global` band
 * used to hide half the types and turn the busy ones into density heatmaps; the version
 * after that kept every type but folded crowds into counted cluster bubbles. Both answer
 * "roughly how many" and refuse to answer "where, exactly, is each one", which is the
 * question the overview is for.
 *
 * Drawing every object is affordable because a point is cheap on the GPU — Cesium's
 * `PointPrimitiveCollection` and MapLibre's circle layer both draw tens of thousands per
 * frame — so long as the *CPU* is not rebuilding them every frame. That is the other half
 * of this change: presentation no longer re-runs when the camera moves (see `cullToView`
 * and the desktop map host), only when data, lens, selection or LOD band change.
 *
 * `clusterPx` and `densityCellDeg` remain in the rule format for a lens that genuinely wants
 * aggregation; no default rule sets them.
 */
export const DEFAULT_RULES: RenderingRule[] = [
  {
    objectTypes: ['aircraft'],
    lod: { global: 'points', continental: 'points', regional: 'markers', local: 'icons' },
    styleClass: 'aircraft',
    icon: 'aircraft',
    basePriority: 50,
    clusterPx: 0,
    pointPx: 5,
    markerPx: 8,
  },
  {
    objectTypes: ['vessel'],
    lod: { global: 'points', continental: 'points', regional: 'markers', local: 'icons' },
    styleClass: 'vessel',
    icon: 'vessel',
    basePriority: 40,
    clusterPx: 0,
    pointPx: 4.5,
    markerPx: 7,
  },
  {
    objectTypes: ['satellite'],
    lod: { global: 'points', continental: 'points', regional: 'markers', local: 'markers' },
    styleClass: 'satellite',
    icon: 'satellite',
    basePriority: 30,
    clusterPx: 0,
    pointPx: 3.5,
    markerPx: 5,
  },
  {
    objectTypes: ['earthquake'],
    lod: { global: 'markers', continental: 'markers', regional: 'markers', local: 'icons' },
    styleClass: 'earthquake',
    basePriority: 70,
    sizeBy: { property: 'magnitude', min: 1, max: 9, scale: [4, 28] },
    colorBy: {
      property: 'depthKm',
      bands: [
        { upTo: 70, suffix: 'shallow' },
        { upTo: 300, suffix: 'intermediate' },
        { upTo: Number.POSITIVE_INFINITY, suffix: 'deep' },
      ],
    },
    clusterPx: 0,
  },
  {
    objectTypes: ['fire-detection'],
    lod: { global: 'points', continental: 'points', regional: 'points', local: 'markers' },
    styleClass: 'fire',
    icon: 'fire',
    basePriority: 60,
    clusterPx: 0,
    pointPx: 4,
    markerPx: 6,
  },
  {
    objectTypes: ['weather-alert', 'storm'],
    lod: { global: 'markers', continental: 'markers', regional: 'markers', local: 'icons' },
    styleClass: 'weather-alert',
    icon: 'alert',
    basePriority: 65,
    clusterPx: 0,
  },
  {
    objectTypes: ['weather-station'],
    lod: { global: 'points', continental: 'points', regional: 'markers', local: 'icons' },
    styleClass: 'weather-station',
    icon: 'weather',
    basePriority: 20,
    clusterPx: 0,
    pointPx: 4,
    markerPx: 6,
  },
  {
    objectTypes: ['camera'],
    lod: { global: 'points', continental: 'points', regional: 'points', local: 'icons' },
    styleClass: 'camera',
    icon: 'camera',
    basePriority: 35,
    clusterPx: 0,
    pointPx: 4,
    markerPx: 6,
  },
  {
    objectTypes: ['transit-vehicle'],
    lod: { global: 'points', continental: 'points', regional: 'points', local: 'icons' },
    styleClass: 'transit',
    icon: 'transit',
    basePriority: 30,
    clusterPx: 0,
    pointPx: 4,
    markerPx: 6,
  },
  {
    objectTypes: ['airport', 'port', 'infrastructure', 'place'],
    lod: { global: 'points', continental: 'points', regional: 'markers', local: 'icons' },
    styleClass: 'infrastructure',
    icon: 'infrastructure',
    basePriority: 25,
    clusterPx: 0,
    pointPx: 3.5,
    markerPx: 6,
  },
  {
    objectTypes: ['launch'],
    lod: { global: 'markers', continental: 'markers', regional: 'icons', local: 'icons' },
    styleClass: 'launch',
    icon: 'launch',
    basePriority: 55,
    clusterPx: 0,
  },
  {
    objectTypes: ['sensor'],
    lod: { global: 'points', continental: 'points', regional: 'markers', local: 'icons' },
    styleClass: 'sensor',
    icon: 'sensor',
    basePriority: 30,
    clusterPx: 0,
    pointPx: 4,
    markerPx: 6,
  },
];

export interface PresentationInput {
  objects: Iterable<WorldObject>;
  events?: Iterable<WorldEvent>;
  view: ViewState;
  rules?: RenderingRule[];
  /** Object types visible in the active lens (undefined = all). */
  visibleTypes?: ReadonlySet<string>;
  selectedId?: string | null;
  hoveredId?: string | null;
  /** Track for the selected object (rendered as a trail). */
  selectedTrack?: ReadonlyArray<{ latitude: number; longitude: number; altitudeM?: number }>;
  /** Watch zones, outlined under everything else; a paused zone is drawn dimmer. */
  zones?: Iterable<PresentedZone>;
  /**
   * Give satellites their `motion` (RenderFeature) so the globe moves them continuously.
   * Only while the timeline is live: paused or replaying, a satellite is where the moment
   * shown puts it.
   */
  animate?: boolean;
  /** Hard cap on emitted features (dense-rendering abstraction handles the rest). */
  maxFeatures?: number;
  /** How much of each rule to honour; set by the performance governor. Default 0 (full). */
  detail?: DetailLevel;
  /**
   * Drop objects outside the view (default true). The desktop shell passes false: the
   * renderers cull on the GPU for free, and culling here made the visible set depend on the
   * exact camera, so every pan re-ran presentation and churned points in and out at the
   * edges — the "buffering" of points while moving. The data is already bounded upstream by
   * the viewport subscription at any zoom where the whole world is not in view.
   */
  cullToView?: boolean;
  /**
   * Features built on an earlier pass, keyed by the object they were built from. The shell's
   * mirror replaces an object only when it changes, so an object that is the same reference
   * as last pass — with the same rule, mode, selection and hover — gets last pass's feature
   * back, the very same object, and the diff passes it over without comparing a field. At
   * 30,000 objects that was ~25 ms of every pass (building ~30,000 features and comparing
   * them to the last ~30,000) for the handful that had changed.
   */
  featureCache?: FeatureCache;
}

/** See PresentationInput.featureCache. Weak: an object the mirror has dropped takes its entry with it. */
export type FeatureCache = WeakMap<WorldObject, CachedFeature>;

export interface CachedFeature {
  rule: RenderingRule;
  mode: LodMode;
  selected: boolean;
  hovered: boolean;
  animate: boolean;
  feature: RenderFeature;
}

export function createFeatureCache(): FeatureCache {
  return new WeakMap();
}

export interface PresentationResult extends FeatureUpdate {
  stats: {
    objects: number;
    features: number;
    clustered: number;
    density: number;
    hidden: number;
    band: LodBand;
    detail: DetailLevel;
  };
}

function ruleFor(rules: RenderingRule[], type: string): RenderingRule | undefined {
  return rules.find((r) => r.objectTypes.includes(type));
}

function sizeFor(rule: RenderingRule, obj: WorldObject, base: number): number {
  if (!rule.sizeBy) return base;
  const v = obj.properties[rule.sizeBy.property];
  if (typeof v !== 'number') return base;
  const t = Math.max(0, Math.min(1, (v - rule.sizeBy.min) / (rule.sizeBy.max - rule.sizeBy.min)));
  return rule.sizeBy.scale[0] + t * (rule.sizeBy.scale[1] - rule.sizeBy.scale[0]);
}

function styleClassFor(rule: RenderingRule, obj: WorldObject): string {
  if (!rule.colorBy) return rule.styleClass;
  const v = obj.properties[rule.colorBy.property];
  if (typeof v !== 'number') return rule.styleClass;
  const band = rule.colorBy.bands.find((b) => v <= b.upTo);
  return band ? `${rule.styleClass}.${band.suffix}` : rule.styleClass;
}

function viewBounds(view: ViewState): GeoBounds {
  if (view.bounds) return view.bounds;
  // Fallback: approximate from altitude.
  return circleBounds(view.center, Math.max(50_000, view.altitudeM * 1.2));
}

/** Screen-space grid clustering: cell size in degrees derived from px at current zoom. */
function clusterCellDeg(px: number, zoom: number, latitude: number): number {
  const metersPerPixel = (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
  return Math.max(0.0005, (px * metersPerPixel) / 111_320);
}

/** What hovering adds to an object feature's priority — the one thing hover changes besides its style. */
export const HOVER_PRIORITY = 10;

/**
 * The features that change when nothing but the hover target does, taken from the frame
 * already presented rather than by presenting every object again.
 *
 * Hover moves whenever the cursor crosses a dot, and on an overview full of dots that is
 * every few frames. Each change used to re-run presentation over every object — a whole
 * pass on the main thread, and in 2D a re-index of every source it touched — to restyle
 * two features. The result is the same as a full pass would give for those two (a test
 * holds it to that); anything hover does not reach is left alone.
 */
export function restyleHover(
  presented: ReadonlyMap<string, RenderFeature>,
  from: string | null | undefined,
  to: string | null | undefined,
): RenderFeature[] {
  const out: RenderFeature[] = [];
  if ((from ?? null) === (to ?? null)) return out;
  for (const [objectId, hovered] of [
    [from, false],
    [to, true],
  ] as const) {
    if (!objectId) continue;
    const f = presented.get(`obj:${objectId}`);
    if (!f || (f.style.hovered ?? false) === hovered) continue;
    out.push({
      ...f,
      style: { ...f.style, hovered },
      priority: f.priority + (hovered ? HOVER_PRIORITY : -HOVER_PRIORITY),
    });
  }
  return out;
}

export function presentObjects(input: PresentationInput): PresentationResult {
  const rules = input.rules ?? DEFAULT_RULES;
  const band = lodBand(input.view.zoom);
  const bounds = viewBounds(input.view);
  const maxFeatures = input.maxFeatures ?? 50_000;
  const detail = input.detail ?? 0;
  const cull = input.cullToView ?? true;
  const upsert: RenderFeature[] = [];
  const stats = { objects: 0, features: 0, clustered: 0, density: 0, hidden: 0, band, detail };

  // Group by rule → mode.
  const densityCells = new Map<
    string,
    { rule: RenderingRule; cells: Map<string, { count: number; lat: number; lon: number; bounds: GeoBounds }> }
  >();
  const clusterCells = new Map<
    string,
    { rule: RenderingRule; cells: Map<string, { members: WorldObject[]; lat: number; lon: number }> }
  >();
  const cellSizeCache = new Map<string, number>();
  // One rule lookup per type, not per object.
  const ruleByType = new Map<string, RenderingRule | undefined>();
  const cache = input.featureCache;
  const animate = input.animate ?? false;

  for (const obj of input.objects) {
    stats.objects++;
    if (input.visibleTypes && !input.visibleTypes.has(obj.type)) {
      stats.hidden++;
      continue;
    }
    let rule = ruleByType.get(obj.type);
    if (rule === undefined && !ruleByType.has(obj.type)) {
      rule = ruleFor(rules, obj.type);
      ruleByType.set(obj.type, rule);
    }
    if (!rule) {
      stats.hidden++;
      continue;
    }
    const selected = obj.id === input.selectedId;
    const hovered = obj.id === input.hoveredId;
    const mode: LodMode = selected ? 'icons' : effectiveMode(rule, band, detail);
    if (mode === 'hidden') {
      stats.hidden++;
      continue;
    }
    const pos = obj.position;
    if (!pos) {
      const g = obj.geometry ? worldGeometryToRender(obj.geometry) : undefined;
      if (g)
        upsert.push({
          id: `obj:${obj.id}`,
          objectId: obj.id,
          geometry: g,
          style: { styleClass: rule.styleClass, selected, hovered, freshness: obj.freshness },
          interactive: true,
          priority: rule.basePriority + (hovered ? HOVER_PRIORITY : 0),
          layer: rule.styleClass,
        });
      continue;
    }
    if (cull && !selected && !boundsContain(bounds, pos)) {
      stats.hidden++;
      continue;
    }

    if (mode === 'density' && !selected) {
      const cellDeg = rule.densityCellDeg?.[band] ?? DENSITY_FALLBACK_CELL_DEG[band];
      const key = `${rule.styleClass}`;
      let entry = densityCells.get(key);
      if (!entry) {
        entry = { rule, cells: new Map() };
        densityCells.set(key, entry);
      }
      const row = Math.floor((pos.latitude + 90) / cellDeg),
        col = Math.floor((pos.longitude + 180) / cellDeg);
      const ck = `${row}:${col}`;
      let cell = entry.cells.get(ck);
      if (!cell) {
        const south = -90 + row * cellDeg,
          west = -180 + col * cellDeg;
        cell = {
          count: 0,
          lat: south + cellDeg / 2,
          lon: west + cellDeg / 2,
          bounds: { south, north: south + cellDeg, west, east: west + cellDeg },
        };
        entry.cells.set(ck, cell);
      }
      cell.count++;
      continue;
    }

    if ((mode === 'points' || mode === 'markers') && (rule.clusterPx ?? 0) > 0 && !selected) {
      const px = rule.clusterPx! * CLUSTER_SCALE[detail];
      let cellDeg = cellSizeCache.get(rule.styleClass);
      if (cellDeg === undefined) {
        cellDeg = clusterCellDeg(px, input.view.zoom, input.view.center.latitude);
        cellSizeCache.set(rule.styleClass, cellDeg);
      }
      let entry = clusterCells.get(rule.styleClass);
      if (!entry) {
        entry = { rule, cells: new Map() };
        clusterCells.set(rule.styleClass, entry);
      }
      const ck = `${Math.floor(pos.latitude / cellDeg)}:${Math.floor(pos.longitude / cellDeg)}`;
      let cell = entry.cells.get(ck);
      if (!cell) {
        cell = { members: [], lat: 0, lon: 0 };
        entry.cells.set(ck, cell);
      }
      cell.members.push(obj);
      continue;
    }

    upsert.push(cachedObjectFeature(cache, obj, rule, mode, selected, hovered, animate));
  }

  for (const { rule, cells } of densityCells.values()) {
    let max = 1;
    for (const c of cells.values()) max = Math.max(max, c.count);
    for (const [ck, c] of cells) {
      stats.density++;
      upsert.push({
        id: `density:${rule.styleClass}:${ck}`,
        geometry: { kind: 'density', bounds: c.bounds, count: c.count, intensity: c.count / max },
        style: { styleClass: `${rule.styleClass}.density`, label: String(c.count) },
        interactive: false,
        priority: rule.basePriority - 20,
        layer: `${rule.styleClass}.density`,
      });
    }
  }

  for (const { rule, cells } of clusterCells.values()) {
    for (const [ck, cell] of cells) {
      if (cell.members.length === 1) {
        upsert.push(
          objectFeature(
            cell.members[0]!,
            rule,
            effectiveMode(rule, band, detail) === 'points' ? 'points' : 'markers',
            false,
            cell.members[0]!.id === input.hoveredId,
            animate,
          ),
        );
        continue;
      }
      stats.clustered += cell.members.length;
      let lat = 0,
        lon = 0,
        south = 90,
        north = -90,
        west = 180,
        east = -180;
      for (const m of cell.members) {
        lat += m.position!.latitude;
        lon += m.position!.longitude;
        south = Math.min(south, m.position!.latitude);
        north = Math.max(north, m.position!.latitude);
        west = Math.min(west, m.position!.longitude);
        east = Math.max(east, m.position!.longitude);
      }
      const n = cell.members.length;
      upsert.push({
        id: `cluster:${rule.styleClass}:${ck}`,
        geometry: {
          kind: 'cluster',
          position: { latitude: lat / n, longitude: lon / n },
          count: n,
          bounds: { south, north, west, east },
        },
        style: {
          styleClass: `${rule.styleClass}.cluster`,
          label: String(n),
          size: Math.min(48, 16 + Math.log2(n) * 4),
        },
        interactive: true,
        priority: rule.basePriority - 10,
        layer: `${rule.styleClass}.cluster`,
      });
    }
  }

  // Selected trail.
  if (input.selectedId && input.selectedTrack && input.selectedTrack.length > 1) {
    upsert.push({
      id: `trail:${input.selectedId}`,
      objectId: input.selectedId,
      geometry: {
        kind: 'line',
        positions: input.selectedTrack.map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          ...(p.altitudeM !== undefined ? { altitudeM: p.altitudeM } : {}),
        })),
      },
      style: { styleClass: 'trail', lineStyle: 'trail', size: 2 },
      interactive: false,
      priority: 90,
      layer: 'trail',
    });
  }

  for (const z of input.zones ?? []) {
    const geometry = zoneGeometry(z.region);
    if (!geometry) continue;
    upsert.push({
      id: `zone:${z.id}`,
      geometry,
      style: {
        styleClass: z.enabled ? 'watchzone' : 'watchzone.paused',
        opacity: z.enabled ? 0.5 : 0.3,
        label: z.name,
      },
      // Not a pick target: a click inside a zone is meant for what is in it.
      interactive: false,
      priority: 60,
      layer: 'watchzones',
    });
  }

  for (const ev of input.events ?? []) {
    if (!ev.geometry) continue;
    const g = worldGeometryToRender(ev.geometry);
    if (!g) continue;
    const selected = ev.id === input.selectedId;
    upsert.push({
      id: `event:${ev.id}`,
      eventId: ev.id,
      geometry: g,
      style: { styleClass: `event.${ev.type}`, label: ev.title, selected, opacity: 0.6 },
      interactive: true,
      priority: 80,
      layer: 'events',
    });
  }

  // Priority cap: keep the most important features.
  let features = upsert;
  if (features.length > maxFeatures) {
    features = features.sort((a, b) => b.priority - a.priority).slice(0, maxFeatures);
  }
  stats.features = features.length;
  return { upsert: features, remove: [], stats };
}

export interface PresentedZone {
  id: string;
  name: string;
  region: GeoRegion;
  enabled: boolean;
}

/**
 * A zone's outline. An admin region is drawn only as what it is known by: it has no outline
 * of its own here, and its bounding box would claim an area the zone does not cover.
 */
export function zoneGeometry(region: GeoRegion): RenderGeometry | undefined {
  switch (region.kind) {
    case 'circle':
      return { kind: 'circle', center: region.center, radiusM: region.radiusM };
    case 'bounds': {
      const b = region.bounds;
      return {
        kind: 'polygon',
        rings: [
          [
            { latitude: b.south, longitude: b.west },
            { latitude: b.south, longitude: b.east },
            { latitude: b.north, longitude: b.east },
            { latitude: b.north, longitude: b.west },
            { latitude: b.south, longitude: b.west },
          ],
        ],
      };
    }
    case 'polygon': {
      if (region.polygon.length < 3) return undefined;
      const ring = region.polygon.map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      if (first.latitude !== last.latitude || first.longitude !== last.longitude) ring.push(first);
      return { kind: 'polygon', rings: [ring] };
    }
    default:
      return undefined;
  }
}

function cachedObjectFeature(
  cache: FeatureCache | undefined,
  obj: WorldObject,
  rule: RenderingRule,
  mode: LodMode,
  selected: boolean,
  hovered: boolean,
  animate: boolean,
): RenderFeature {
  if (!cache) return objectFeature(obj, rule, mode, selected, hovered, animate);
  const hit = cache.get(obj);
  if (
    hit &&
    hit.rule === rule &&
    hit.mode === mode &&
    hit.selected === selected &&
    hit.hovered === hovered &&
    hit.animate === animate
  )
    return hit.feature;
  const feature = objectFeature(obj, rule, mode, selected, hovered, animate);
  cache.set(obj, { rule, mode, selected, hovered, animate, feature });
  return feature;
}

/** The longest gap between a satellite's two propagations that is drawn as one straight move. */
const MAX_MOTION_SPAN_MS = 120_000;

/**
 * A satellite's move from where it was propagated to (`propagatedAt`) to where it will be at
 * the next poll (`nextPosition`, celestrak normalize.ts), or undefined when the two do not
 * describe one short step forward.
 */
export function satelliteMotion(obj: WorldObject): RenderMotion | undefined {
  if (obj.type !== 'satellite' || !obj.position) return undefined;
  const next = obj.properties['nextPosition'];
  const at = obj.properties['propagatedAt'];
  if (!Array.isArray(next) || next.length !== 4 || typeof at !== 'string') return undefined;
  const [lat, lon, alt, toMs] = next as unknown[];
  const fromMs = Date.parse(at);
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    typeof alt !== 'number' ||
    typeof toMs !== 'number' ||
    !Number.isFinite(fromMs) ||
    !(toMs > fromMs) ||
    toMs - fromMs > MAX_MOTION_SPAN_MS ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return undefined;
  return { to: { latitude: lat, longitude: lon, altitudeM: alt }, fromMs, toMs };
}

function objectFeature(
  obj: WorldObject,
  rule: RenderingRule,
  mode: LodMode,
  selected: boolean,
  hovered: boolean,
  animate = false,
): RenderFeature {
  const pos = obj.position!;
  const base = mode === 'points' ? (rule.pointPx ?? 4) : mode === 'markers' ? (rule.markerPx ?? 7) : 10;
  const style: RenderStyle = {
    styleClass: styleClassFor(rule, obj),
    size: sizeFor(rule, obj, selected ? base * 1.6 : base),
    freshness: obj.freshness,
    selected,
    hovered,
    heightMode:
      pos.altitudeM !== undefined && (obj.type === 'aircraft' || obj.type === 'satellite') ? 'absolute' : 'clamp',
  };
  if (mode === 'icons' && rule.icon) style.icon = rule.icon;
  if (obj.motion?.headingDegrees !== undefined && (mode === 'icons' || mode === 'markers'))
    style.rotationDegrees = obj.motion.headingDegrees;
  if (mode === 'icons' || selected) {
    const label = obj.labels['callsign'] ?? obj.labels['name'] ?? obj.labels['title'] ?? obj.labels['place'];
    if (label)
      style.label =
        obj.type === 'earthquake' && typeof obj.properties['magnitude'] === 'number'
          ? `M${(obj.properties['magnitude'] as number).toFixed(1)}`
          : label;
    style.labelPriority = rule.basePriority + (selected ? 100 : 0);
  }
  if (obj.freshness === 'STALE') style.opacity = 0.55;
  const feature: RenderFeature = {
    id: `obj:${obj.id}`,
    objectId: obj.id,
    geometry: { kind: 'point', position: pos },
    style,
    interactive: true,
    priority: rule.basePriority + (selected ? 100 : 0) + (hovered ? HOVER_PRIORITY : 0),
    layer: rule.styleClass,
  };
  const motion = animate ? satelliteMotion(obj) : undefined;
  if (motion) feature.motion = motion;
  return feature;
}

export interface FeatureDiff extends FeatureUpdate {
  /**
   * Index of the frame that was just presented, ready to become the next `previous`.
   * It is built during the diff, so a caller never has to walk the feature list again.
   */
  index: Map<string, RenderFeature>;
}

export function diffFeatures(
  previous: ReadonlyMap<string, RenderFeature>,
  next: readonly RenderFeature[],
): FeatureDiff {
  // Presentation rebuilds every feature each frame, so the diff walks the whole visible
  // set: at 100k objects that is ~29k comparisons per frame. Two things keep it inside a
  // frame budget — comparing fields directly instead of serialising both sides, and
  // indexing the new frame in the same pass so neither the diff nor its caller needs a
  // second walk to find removals.
  const index = new Map<string, RenderFeature>();
  const upsert: RenderFeature[] = [];
  let matched = 0;
  for (const f of next) {
    const sizeBefore = index.size;
    index.set(f.id, f);
    const firstOccurrence = index.size !== sizeBefore;
    const prev = previous.get(f.id);
    if (prev === undefined) {
      upsert.push(f);
      continue;
    }
    if (firstOccurrence) matched++;
    // The same feature object as last pass (PresentationInput.featureCache): nothing to compare.
    if (prev !== f && !featureEqual(prev, f)) upsert.push(f);
  }
  const remove: string[] = [];
  // `matched` counts distinct previous ids that survived (a repeated id in `next` is
  // counted once). When every previous id survived nothing was removed and the scan is
  // pointless — that is the steady state (objects move, the visible set does not), and the
  // scan is the most expensive part of the diff at 100k features.
  if (matched !== previous.size) {
    for (const id of previous.keys()) if (!index.has(id)) remove.push(id);
  }
  return { upsert, remove, index };
}

function styleEqual(a: RenderStyle, b: RenderStyle): boolean {
  return (
    a.styleClass === b.styleClass &&
    a.size === b.size &&
    a.icon === b.icon &&
    a.label === b.label &&
    a.selected === b.selected &&
    a.hovered === b.hovered &&
    a.freshness === b.freshness &&
    a.opacity === b.opacity &&
    a.color === b.color &&
    a.rotationDegrees === b.rotationDegrees &&
    a.labelPriority === b.labelPriority &&
    a.heightMode === b.heightMode &&
    a.lineStyle === b.lineStyle
  );
}

function positionEqual(a: GeoPosition, b: GeoPosition): boolean {
  return (
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.altitudeM === b.altitudeM &&
    a.altitudeDatum === b.altitudeDatum &&
    a.accuracyM === b.accuracyM
  );
}

function positionsEqual(a: readonly GeoPosition[], b: readonly GeoPosition[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!positionEqual(a[i]!, b[i]!)) return false;
  return true;
}

function boundsEqual(a: GeoBounds, b: GeoBounds): boolean {
  return a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north;
}

function geometryEqual(a: RenderGeometry, b: RenderGeometry): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'point':
      return positionEqual(a.position, (b as typeof a).position);
    case 'line':
      return positionsEqual(a.positions, (b as typeof a).positions);
    case 'polygon': {
      const other = b as typeof a;
      if (a.rings.length !== other.rings.length) return false;
      for (let i = 0; i < a.rings.length; i++) if (!positionsEqual(a.rings[i]!, other.rings[i]!)) return false;
      return true;
    }
    case 'circle': {
      const other = b as typeof a;
      return a.radiusM === other.radiusM && positionEqual(a.center, other.center);
    }
    case 'cluster': {
      const other = b as typeof a;
      return (
        a.count === other.count && positionEqual(a.position, other.position) && boundsEqual(a.bounds, other.bounds)
      );
    }
    case 'density': {
      const other = b as typeof a;
      return a.count === other.count && a.intensity === other.intensity && boundsEqual(a.bounds, other.bounds);
    }
  }
}

function motionEqual(a: RenderMotion | undefined, b: RenderMotion | undefined): boolean {
  if (!a || !b) return a === b;
  return a.fromMs === b.fromMs && a.toMs === b.toMs && positionEqual(a.to, b.to);
}

function featureEqual(a: RenderFeature, b: RenderFeature): boolean {
  return (
    a.priority === b.priority &&
    a.interactive === b.interactive &&
    a.layer === b.layer &&
    a.objectId === b.objectId &&
    a.eventId === b.eventId &&
    a.validAt === b.validAt &&
    styleEqual(a.style, b.style) &&
    geometryEqual(a.geometry, b.geometry) &&
    motionEqual(a.motion, b.motion)
  );
}
