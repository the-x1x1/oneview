import type { FeatureUpdate, RenderFeature, RenderingRule, Theme } from '@worldview/render-core';
import { toOverlayFeature, type GeoJsonFeature, type GeoJsonFeatureCollection } from './geojson.js';

/**
 * One GeoJSON source per `RenderFeature.layer`. `apply()` diffs a FeatureUpdate
 * into the per-layer collections and marks the touched layers dirty; the
 * renderer flushes dirty layers with one `setData` each, at most once per frame.
 * Pure: no MapLibre here.
 */
export interface ClusterOptions { radiusPx: number; maxZoom: number; minPoints?: number }

/** Cluster settings per layer derived from the presentation rules (`clusterPx` > 0 ⇒ clusterable). */
export function clusterOptionsFromRules(rules: RenderingRule[], maxZoom = 9): Map<string, ClusterOptions> {
  const out = new Map<string, ClusterOptions>();
  for (const r of rules) if ((r.clusterPx ?? 0) > 0) out.set(r.styleClass, { radiusPx: r.clusterPx!, maxZoom, minPoints: 3 });
  return out;
}

export class SourceModel {
  private readonly layers = new Map<string, Map<string, GeoJsonFeature>>();
  private readonly layerOf = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly styleOverride: ((f: RenderFeature) => RenderFeature) | undefined;

  constructor(private readonly theme?: Theme, styleOverride?: (f: RenderFeature) => RenderFeature) {
    this.styleOverride = styleOverride;
  }

  get size(): number { return this.layerOf.size; }
  layerIds(): string[] { return [...this.layers.keys()]; }
  has(id: string): boolean { return this.layerOf.has(id); }
  layerFor(id: string): string | undefined { return this.layerOf.get(id); }
  feature(id: string): GeoJsonFeature | undefined { const l = this.layerOf.get(id); return l ? this.layers.get(l)?.get(id) : undefined; }

  /** Apply an update; returns the ids of layers whose data changed. */
  apply(update: FeatureUpdate, transform?: (f: RenderFeature) => RenderFeature): string[] {
    const touched = new Set<string>();
    if (update.replaceLayers) {
      const keep = new Set(update.upsert.map((f) => f.id));
      for (const layer of update.replaceLayers) {
        const map = this.layers.get(layer);
        if (!map) continue;
        for (const id of [...map.keys()]) if (!keep.has(id)) { map.delete(id); this.layerOf.delete(id); }
        touched.add(layer);
      }
    }
    for (const id of update.remove) { const layer = this.deleteFeature(id); if (layer) touched.add(layer); }
    for (const raw of update.upsert) {
      const f = transform ? transform(raw) : this.styleOverride ? this.styleOverride(raw) : raw;
      const previousLayer = this.layerOf.get(f.id);
      if (previousLayer && previousLayer !== f.layer) { this.deleteFeature(f.id); touched.add(previousLayer); }
      const gj = toOverlayFeature(f, this.theme);
      if (!gj) { if (previousLayer) touched.add(previousLayer); continue; }
      let map = this.layers.get(f.layer);
      if (!map) { map = new Map(); this.layers.set(f.layer, map); }
      map.set(f.id, gj);
      this.layerOf.set(f.id, f.layer);
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
    this.dirty.add(layer);
    return true;
  }

  private deleteFeature(id: string): string | undefined {
    const layer = this.layerOf.get(id);
    if (!layer) return undefined;
    this.layerOf.delete(id);
    const map = this.layers.get(layer);
    map?.delete(id);
    return layer;
  }

  collection(layer: string): GeoJsonFeatureCollection {
    const map = this.layers.get(layer);
    return { type: 'FeatureCollection', features: map ? [...map.values()] : [] };
  }

  /** Dirty layers since the last call, then reset. */
  takeDirty(): string[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  clear(layer?: string): string[] {
    if (layer) {
      const map = this.layers.get(layer);
      if (!map) return [];
      for (const id of map.keys()) this.layerOf.delete(id);
      map.clear();
      this.dirty.add(layer);
      return [layer];
    }
    const all = [...this.layers.keys()];
    for (const l of all) { this.layers.get(l)!.clear(); this.dirty.add(l); }
    this.layerOf.clear();
    return all;
  }
}
