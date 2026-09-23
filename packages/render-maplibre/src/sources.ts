import type { FeatureUpdate, RenderFeature, RenderingRule, Theme } from '@worldview/render-core';
import { toOverlayFeature, type GeoJsonFeature, type GeoJsonFeatureCollection } from './geojson.js';

/**
 * One GeoJSON source per `RenderFeature.layer`. `apply()` diffs a FeatureUpdate
 * into the per-layer collections and marks the touched layers dirty; the
 * renderer flushes dirty layers at most once per frame — as a diff (`updateData`) when the
 * layer already exists in the map, as a full `setData` when it does not.
 * Pure: no MapLibre here.
 */
export interface ClusterOptions {
  radiusPx: number;
  maxZoom: number;
  minPoints?: number;
}

/** Cluster settings per layer derived from the presentation rules (`clusterPx` > 0 ⇒ clusterable). */
export function clusterOptionsFromRules(rules: RenderingRule[], maxZoom = 9): Map<string, ClusterOptions> {
  const out = new Map<string, ClusterOptions>();
  for (const r of rules)
    if ((r.clusterPx ?? 0) > 0) out.set(r.styleClass, { radiusPx: r.clusterPx!, maxZoom, minPoints: 3 });
  return out;
}

/**
 * What changed in one layer since the last flush. `full` means the layer has to be replaced
 * wholesale (it was cleared or replaced, or has never been pushed); otherwise `remove` and
 * `add` are a diff MapLibre can apply with `GeoJSONSource.updateData` — a replaced feature
 * appears in both, since MapLibre applies removals before additions.
 */
export interface LayerChange {
  layer: string;
  full: boolean;
  remove: string[];
  add: GeoJsonFeature[];
  /** Features in the layer after the change. */
  size: number;
}

export class SourceModel {
  private readonly layers = new Map<string, Map<string, GeoJsonFeature>>();
  private readonly layerOf = new Map<string, string>();
  private readonly dirty = new Set<string>();
  /** Per dirty layer: ids to take out, ids to (re)send, or `full` when a diff will not do. */
  private readonly pending = new Map<string, { removed: Set<string>; upserted: Set<string>; full: boolean }>();
  private readonly styleOverride: ((f: RenderFeature) => RenderFeature) | undefined;
  /**
   * Features taken out of their layer's source while they move (motion.ts): kept here and
   * updated as usual, but left out of `collection` and the diffs, and drawn from the
   * companion source instead. `touchedHeld` collects the layers whose held features changed.
   */
  private readonly held = new Set<string>();
  private readonly touchedHeld = new Set<string>();

  constructor(
    private readonly theme?: Theme,
    styleOverride?: (f: RenderFeature) => RenderFeature,
  ) {
    this.styleOverride = styleOverride;
  }

  private pendingFor(layer: string) {
    let p = this.pending.get(layer);
    if (!p) {
      p = { removed: new Set(), upserted: new Set(), full: false };
      this.pending.set(layer, p);
    }
    return p;
  }

  get size(): number {
    return this.layerOf.size;
  }
  layerIds(): string[] {
    return [...this.layers.keys()];
  }
  has(id: string): boolean {
    return this.layerOf.has(id);
  }
  layerFor(id: string): string | undefined {
    return this.layerOf.get(id);
  }
  feature(id: string): GeoJsonFeature | undefined {
    const l = this.layerOf.get(id);
    return l ? this.layers.get(l)?.get(id) : undefined;
  }

  /** Apply an update; returns the ids of layers whose data changed. */
  apply(update: FeatureUpdate, transform?: (f: RenderFeature) => RenderFeature): string[] {
    const touched = new Set<string>();
    if (update.replaceLayers) {
      const keep = new Set(update.upsert.map((f) => f.id));
      for (const layer of update.replaceLayers) {
        const map = this.layers.get(layer);
        if (!map) continue;
        for (const id of [...map.keys()])
          if (!keep.has(id)) {
            map.delete(id);
            this.layerOf.delete(id);
            if (this.held.delete(id)) this.touchedHeld.add(layer);
          }
        this.pendingFor(layer).full = true;
        touched.add(layer);
      }
    }
    for (const id of update.remove) {
      const layer = this.deleteFeature(id);
      if (layer) {
        const p = this.pendingFor(layer);
        p.removed.add(id);
        p.upserted.delete(id);
        touched.add(layer);
      }
    }
    for (const raw of update.upsert) {
      const f = transform ? transform(raw) : this.styleOverride ? this.styleOverride(raw) : raw;
      const previousLayer = this.layerOf.get(f.id);
      if (previousLayer && previousLayer !== f.layer) {
        this.deleteFeature(f.id);
        const p = this.pendingFor(previousLayer);
        p.removed.add(f.id);
        p.upserted.delete(f.id);
        touched.add(previousLayer);
      }
      const gj = toOverlayFeature(f, this.theme);
      if (!gj) {
        if (previousLayer) {
          // The feature can no longer be drawn; it has to leave the source it was in.
          if (previousLayer === f.layer) this.deleteFeature(f.id);
          const p = this.pendingFor(previousLayer);
          p.removed.add(f.id);
          p.upserted.delete(f.id);
          touched.add(previousLayer);
        }
        continue;
      }
      let map = this.layers.get(f.layer);
      if (!map) {
        map = new Map();
        this.layers.set(f.layer, map);
      }
      map.set(f.id, gj);
      this.layerOf.set(f.id, f.layer);
      if (this.held.has(f.id)) {
        this.touchedHeld.add(f.layer);
        continue;
      }
      this.pendingFor(f.layer).upserted.add(f.id);
      touched.add(f.layer);
    }
    for (const l of touched) this.dirty.add(l);
    return [...touched];
  }

  /** Re-derive one feature's GeoJSON (selection highlight) from a RenderFeature already known to the caller. */
  restyle(feature: RenderFeature): boolean {
    const layer = this.layerOf.get(feature.id);
    if (!layer) return false;
    const gj = toOverlayFeature(feature, this.theme);
    if (!gj) return false;
    this.layers.get(layer)!.set(feature.id, gj);
    if (this.held.has(feature.id)) {
      this.touchedHeld.add(layer);
      return true;
    }
    this.pendingFor(layer).upserted.add(feature.id);
    this.dirty.add(layer);
    return true;
  }

  /** Take a feature out of its layer's source while it moves; false when there is no such feature. */
  hold(id: string): boolean {
    const layer = this.layerOf.get(id);
    if (!layer || this.held.has(id)) return false;
    this.held.add(id);
    const p = this.pendingFor(layer);
    p.upserted.delete(id);
    p.removed.add(id);
    this.dirty.add(layer);
    this.touchedHeld.add(layer);
    return true;
  }

  /**
   * Put a moving feature back in its layer's source — at `coordinates` when given (where it had
   * moved to, so stopping does not throw it back to its last report), else where its feature says.
   */
  release(id: string, coordinates?: [number, number]): boolean {
    if (!this.held.delete(id)) return false;
    const layer = this.layerOf.get(id);
    if (!layer) return true;
    const map = this.layers.get(layer)!;
    const gj = map.get(id);
    if (gj && coordinates && gj.geometry.type === 'Point') {
      const alt = gj.geometry.coordinates[2];
      map.set(id, {
        ...gj,
        geometry: { type: 'Point', coordinates: alt !== undefined ? [...coordinates, alt] : [...coordinates] },
      });
    }
    this.pendingFor(layer).upserted.add(id);
    this.dirty.add(layer);
    this.touchedHeld.add(layer);
    return true;
  }

  isHeld(id: string): boolean {
    return this.held.has(id);
  }

  /** The GeoJSON of held features, by id (for the companion sources). */
  heldFeature(id: string): GeoJsonFeature | undefined {
    return this.held.has(id) ? this.feature(id) : undefined;
  }

  /** Layers whose held features were changed, added or released since the last call. */
  takeHeldChanges(): string[] {
    const out = [...this.touchedHeld];
    this.touchedHeld.clear();
    return out;
  }

  private deleteFeature(id: string): string | undefined {
    const layer = this.layerOf.get(id);
    if (!layer) return undefined;
    if (this.held.delete(id)) this.touchedHeld.add(layer);
    this.layerOf.delete(id);
    const map = this.layers.get(layer);
    map?.delete(id);
    return layer;
  }

  collection(layer: string): GeoJsonFeatureCollection {
    const map = this.layers.get(layer);
    if (!map) return { type: 'FeatureCollection', features: [] };
    if (this.held.size === 0) return { type: 'FeatureCollection', features: [...map.values()] };
    const features: GeoJsonFeature[] = [];
    for (const [id, f] of map) if (!this.held.has(id)) features.push(f);
    return { type: 'FeatureCollection', features };
  }

  /** Dirty layers since the last call, then reset. Discards the pending diffs. */
  takeDirty(): string[] {
    const out = [...this.dirty];
    this.dirty.clear();
    this.pending.clear();
    return out;
  }

  /**
   * What changed in each dirty layer since the last call, then reset.
   *
   * The renderer used to replace a whole layer with `setData` whenever any feature in it
   * changed, and MapLibre answers `setData` by re-indexing every feature of the source in
   * its worker. With thousands of aircraft in one layer, one aircraft moving meant all of
   * them being re-tiled — which is what 2D "buffering" was while data streamed in. A diff
   * costs what changed.
   */
  takeChanges(): LayerChange[] {
    const out: LayerChange[] = [];
    for (const layer of this.dirty) {
      const p = this.pending.get(layer);
      const features = this.layers.get(layer);
      const add: GeoJsonFeature[] = [];
      for (const id of p?.upserted ?? []) {
        if (this.held.has(id)) continue;
        const gj = features?.get(id);
        if (gj) add.push(gj);
      }
      // A replaced feature is removed and re-added in the same diff; MapLibre applies
      // removals first, so the pair is a replacement rather than a duplicate.
      const remove = [...new Set([...(p?.removed ?? []), ...(p?.upserted ?? [])])];
      let size = features?.size ?? 0;
      if (this.held.size && features) for (const id of this.held) if (features.has(id)) size--;
      out.push({ layer, full: p?.full ?? true, remove, add, size });
    }
    this.dirty.clear();
    this.pending.clear();
    return out;
  }

  clear(layer?: string): string[] {
    if (layer) {
      const map = this.layers.get(layer);
      if (!map) return [];
      for (const id of map.keys()) {
        this.layerOf.delete(id);
        if (this.held.delete(id)) this.touchedHeld.add(layer);
      }
      map.clear();
      this.pendingFor(layer).full = true;
      this.dirty.add(layer);
      return [layer];
    }
    const all = [...this.layers.keys()];
    if (this.held.size) for (const l of all) this.touchedHeld.add(l);
    this.held.clear();
    for (const l of all) {
      this.layers.get(l)!.clear();
      this.pendingFor(l).full = true;
      this.dirty.add(l);
    }
    this.layerOf.clear();
    return all;
  }
}
