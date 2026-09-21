import { boundsContain, boundsIntersect, circleBounds, haversineMeters, regionBounds, regionContains, type GeoBounds, type GeoRegion } from '@worldview/world-model';

/**
 * @worldview/hot-spatial-index — live (hot-state) spatial index.
 *
 * Decision (ADR-006): fixed-resolution geographic grid cells + exact final filtering.
 * Cells are `cellSizeDeg` × `cellSizeDeg` (default 1°). Every query first collects
 * candidate cells intersecting the query bounds, then applies the exact predicate
 * (bounds/circle/polygon). This gives O(cells + candidates) queries with zero
 * dependencies, predictable memory, and cheap point updates (the common case for
 * moving objects). H3 and RBush were evaluated as alternatives — see the ADR and
 * tools/benchmark for the measurements.
 *
 * DuckDB is never used for hot-state lookups.
 */
export interface SpatialItem {
  id: string;
  latitude: number;
  longitude: number;
  /** Optional type tag for `ofType` filtering without a second index. */
  type?: string;
}

export interface SpatialQueryOptions {
  /** Only items whose `type` is in this set. */
  types?: ReadonlySet<string> | string[];
  limit?: number;
}

export interface SpatialIndex {
  readonly size: number;
  upsert(item: SpatialItem): void;
  remove(id: string): boolean;
  get(id: string): SpatialItem | undefined;
  withinBounds(bounds: GeoBounds, opts?: SpatialQueryOptions): SpatialItem[];
  withinRadius(center: { latitude: number; longitude: number }, radiusM: number, opts?: SpatialQueryOptions): Array<SpatialItem & { distanceM: number }>;
  nearest(center: { latitude: number; longitude: number }, n: number, opts?: SpatialQueryOptions & { maxRadiusM?: number }): Array<SpatialItem & { distanceM: number }>;
  withinRegion(region: GeoRegion, opts?: SpatialQueryOptions): SpatialItem[];
  /** Count of items per cell intersecting `bounds` — used for density aggregation at global zoom. */
  cellCounts(bounds: GeoBounds, opts?: SpatialQueryOptions): Array<{ cell: string; bounds: GeoBounds; count: number }>;
  clear(): void;
}

export interface GridIndexOptions {
  cellSizeDeg?: number;
}

export class GridSpatialIndex implements SpatialIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Map<string, SpatialItem>>();
  private readonly items = new Map<string, { item: SpatialItem; cell: string }>();

  constructor(opts: GridIndexOptions = {}) {
    this.cellSize = opts.cellSizeDeg ?? 1;
    if (!(this.cellSize > 0) || 180 % this.cellSize !== 0) throw new Error('cellSizeDeg must divide 180');
  }

  get size(): number { return this.items.size; }

  private cellKey(lat: number, lon: number): string {
    const row = Math.min(Math.floor((lat + 90) / this.cellSize), Math.ceil(180 / this.cellSize) - 1);
    const col = Math.min(Math.floor((lon + 180) / this.cellSize), Math.ceil(360 / this.cellSize) - 1);
    return `${row}:${col}`;
  }

  private cellBounds(key: string): GeoBounds {
    const [r, c] = key.split(':').map(Number) as [number, number];
    return { south: -90 + r * this.cellSize, north: -90 + (r + 1) * this.cellSize, west: -180 + c * this.cellSize, east: -180 + (c + 1) * this.cellSize };
  }

  upsert(item: SpatialItem): void {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) throw new Error(`invalid position for ${item.id}`);
    const key = this.cellKey(item.latitude, item.longitude);
    const existing = this.items.get(item.id);
    if (existing && existing.cell !== key) {
      const old = this.cells.get(existing.cell);
      old?.delete(item.id);
      if (old && old.size === 0) this.cells.delete(existing.cell);
    }
    let cell = this.cells.get(key);
    if (!cell) { cell = new Map(); this.cells.set(key, cell); }
    cell.set(item.id, item);
    this.items.set(item.id, { item, cell: key });
  }

  remove(id: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    const cell = this.cells.get(e.cell);
    cell?.delete(id);
    if (cell && cell.size === 0) this.cells.delete(e.cell);
    this.items.delete(id);
    return true;
  }

  get(id: string): SpatialItem | undefined { return this.items.get(id)?.item; }

  clear(): void { this.cells.clear(); this.items.clear(); }

  /** Iterate cells intersecting bounds (handles antimeridian crossing by splitting). */
  private *candidateCells(bounds: GeoBounds): Iterable<[string, Map<string, SpatialItem>]> {
    const ranges: GeoBounds[] = bounds.west <= bounds.east ? [bounds] : [{ ...bounds, east: 180 }, { ...bounds, west: -180 }];
    const seen = new Set<string>();
    for (const b of ranges) {
      const r0 = Math.max(0, Math.floor((b.south + 90) / this.cellSize));
      const r1 = Math.min(Math.ceil(180 / this.cellSize) - 1, Math.floor((b.north + 90) / this.cellSize));
      const c0 = Math.max(0, Math.floor((b.west + 180) / this.cellSize));
      const c1 = Math.min(Math.ceil(360 / this.cellSize) - 1, Math.floor((b.east + 180) / this.cellSize));
      // When the query is wider than the cell population, iterate populated cells instead.
      const span = (r1 - r0 + 1) * (c1 - c0 + 1);
      if (span > this.cells.size) {
        for (const [key, cell] of this.cells) {
          if (seen.has(key)) continue;
          if (boundsIntersect(this.cellBounds(key), b)) { seen.add(key); yield [key, cell]; }
        }
        continue;
      }
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const key = `${r}:${c}`;
        if (seen.has(key)) continue;
        const cell = this.cells.get(key);
        if (cell) { seen.add(key); yield [key, cell]; }
      }
    }
  }

  private typeSet(opts?: SpatialQueryOptions): ReadonlySet<string> | undefined {
    if (!opts?.types) return undefined;
    return Array.isArray(opts.types) ? new Set(opts.types) : opts.types;
  }

  withinBounds(bounds: GeoBounds, opts?: SpatialQueryOptions): SpatialItem[] {
    const out: SpatialItem[] = [];
    const types = this.typeSet(opts);
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    for (const [, cell] of this.candidateCells(bounds)) {
      for (const item of cell.values()) {
        if (types && (!item.type || !types.has(item.type))) continue;
        if (boundsContain(bounds, item)) { out.push(item); if (out.length >= limit) return out; }
      }
    }
    return out;
  }

  withinRadius(center: { latitude: number; longitude: number }, radiusM: number, opts?: SpatialQueryOptions): Array<SpatialItem & { distanceM: number }> {
    const out: Array<SpatialItem & { distanceM: number }> = [];
    const types = this.typeSet(opts);
    for (const [, cell] of this.candidateCells(circleBounds(center, radiusM))) {
      for (const item of cell.values()) {
        if (types && (!item.type || !types.has(item.type))) continue;
        const d = haversineMeters(center, item);
        if (d <= radiusM) out.push({ ...item, distanceM: d });
      }
    }
    out.sort((a, b) => a.distanceM - b.distanceM);
    return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  nearest(center: { latitude: number; longitude: number }, n: number, opts?: SpatialQueryOptions & { maxRadiusM?: number }): Array<SpatialItem & { distanceM: number }> {
    const maxRadius = opts?.maxRadiusM ?? 20_000_000;
    // Expand search radius geometrically until n candidates found or the cap is hit.
    let radius = Math.min(maxRadius, Math.max(1000, this.cellSize * 111_000 * 0.5));
    for (;;) {
      const found = this.withinRadius(center, radius, opts?.types ? { types: opts.types } : undefined);
      if (found.length >= n || radius >= maxRadius) return found.slice(0, n);
      radius = Math.min(maxRadius, radius * 4);
    }
  }

  withinRegion(region: GeoRegion, opts?: SpatialQueryOptions): SpatialItem[] {
    const bounds = regionBounds(region);
    if (!bounds) return [];
    if (region.kind === 'bounds') return this.withinBounds(region.bounds, opts);
    const out: SpatialItem[] = [];
    const types = this.typeSet(opts);
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    for (const [, cell] of this.candidateCells(bounds)) {
      for (const item of cell.values()) {
        if (types && (!item.type || !types.has(item.type))) continue;
        if (regionContains(region, item)) { out.push(item); if (out.length >= limit) return out; }
      }
    }
    return out;
  }

  cellCounts(bounds: GeoBounds, opts?: SpatialQueryOptions): Array<{ cell: string; bounds: GeoBounds; count: number }> {
    const types = this.typeSet(opts);
    const out: Array<{ cell: string; bounds: GeoBounds; count: number }> = [];
    for (const [key, cell] of this.candidateCells(bounds)) {
      let count = 0;
      if (!types) count = cell.size;
      else for (const item of cell.values()) if (item.type && types.has(item.type)) count++;
      if (count > 0) out.push({ cell: key, bounds: this.cellBounds(key), count });
    }
    return out;
  }
}

export function createSpatialIndex(opts?: GridIndexOptions): SpatialIndex {
  return new GridSpatialIndex(opts);
}
