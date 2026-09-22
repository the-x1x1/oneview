import type { FeatureUpdate, RenderFeature } from '@worldview/render-core';

/**
 * Where a RenderFeature lands in Cesium. One feature can occupy several
 * collections (an icon plus its label; a cluster disc plus its count). Pure, so
 * the routing rules are tested without primitives.
 */
export type FeatureRoute = 'point' | 'billboard' | 'label' | 'polyline' | 'polygon' | 'circle' | 'density' | 'cluster';

export function routeFeature(feature: RenderFeature): FeatureRoute[] {
  const routes: FeatureRoute[] = [];
  const g = feature.geometry;
  switch (g.kind) {
    case 'point':
      routes.push(feature.style.icon ? 'billboard' : 'point');
      if (feature.style.label) routes.push('label');
      break;
    case 'cluster':
      routes.push('cluster', 'label');
      break;
    case 'line':
      routes.push('polyline');
      break;
    case 'polygon':
      routes.push('polygon');
      if (feature.style.label) routes.push('label');
      break;
    case 'circle':
      routes.push('circle');
      if (feature.style.label) routes.push('label');
      break;
    case 'density':
      routes.push('density');
      break;
  }
  return routes;
}

export interface StoredFeature {
  feature: RenderFeature;
  routes: FeatureRoute[];
}

/** Applies FeatureUpdates and reports exactly what a renderer must add/replace/remove. */
export class FeatureStore {
  private readonly byId = new Map<string, StoredFeature>();
  private readonly byLayer = new Map<string, Set<string>>();

  get size(): number {
    return this.byId.size;
  }
  get(id: string): RenderFeature | undefined {
    return this.byId.get(id)?.feature;
  }
  routesOf(id: string): FeatureRoute[] {
    return this.byId.get(id)?.routes ?? [];
  }
  layers(): string[] {
    return [...this.byLayer.keys()];
  }
  idsInLayer(layer: string): string[] {
    return [...(this.byLayer.get(layer) ?? [])];
  }
  values(): IterableIterator<StoredFeature> {
    return this.byId.values();
  }

  /** Returns the removals (with their previous routes) and the upserts (with previous routes, if any) in application order. */
  apply(update: FeatureUpdate): {
    removed: Array<{ id: string; previous: StoredFeature }>;
    upserted: Array<{ previous: StoredFeature | undefined; next: StoredFeature }>;
  } {
    const removed: Array<{ id: string; previous: StoredFeature }> = [];
    const upserted: Array<{ previous: StoredFeature | undefined; next: StoredFeature }> = [];
    const upsertIds = new Set(update.upsert.map((f) => f.id));
    if (update.replaceLayers) {
      for (const layer of update.replaceLayers) {
        for (const id of this.idsInLayer(layer)) {
          if (upsertIds.has(id)) continue; // will be overwritten below
          const prev = this.delete(id);
          if (prev) removed.push({ id, previous: prev });
        }
      }
    }
    for (const id of update.remove) {
      const prev = this.delete(id);
      if (prev) removed.push({ id, previous: prev });
    }
    for (const feature of update.upsert) {
      const previous = this.byId.get(feature.id);
      const next: StoredFeature = { feature, routes: routeFeature(feature) };
      if (previous && previous.feature.layer !== feature.layer)
        this.byLayer.get(previous.feature.layer)?.delete(feature.id);
      this.byId.set(feature.id, next);
      let set = this.byLayer.get(feature.layer);
      if (!set) {
        set = new Set();
        this.byLayer.set(feature.layer, set);
      }
      set.add(feature.id);
      upserted.push({ previous, next });
    }
    return { removed, upserted };
  }

  clear(layer?: string): string[] {
    if (!layer) {
      const ids = [...this.byId.keys()];
      this.byId.clear();
      this.byLayer.clear();
      return ids;
    }
    const ids = this.idsInLayer(layer);
    for (const id of ids) this.delete(id);
    return ids;
  }

  private delete(id: string): StoredFeature | undefined {
    const prev = this.byId.get(id);
    if (!prev) return undefined;
    this.byId.delete(id);
    const set = this.byLayer.get(prev.feature.layer);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.byLayer.delete(prev.feature.layer);
    }
    return prev;
  }
}
