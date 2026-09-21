import type { FeatureUpdate, LodBand, RenderFeature, WorldRenderer } from '@worldview/render-core';

/**
 * Dense-layer abstraction (ADR-008). A DenseLayerRenderer draws one high-count
 * layer kind. The only implementation today is NativeDenseAdapter, which hands
 * the (budgeted) features to the active WorldRenderer's own primitive/GeoJSON
 * path: no deck.gl until tools/benchmark shows the native adapters missing the
 * 30 FPS heavy-region target.
 */
export type DenseKind = 'points' | 'lines' | 'heatmap';

export interface DenseLayerRenderer {
  readonly kind: DenseKind;
  /** Whether this renderer will keep the frame budget at `count` features. */
  supports(count: number): boolean;
  update(features: RenderFeature[]): void;
  dispose(): void;
}

export interface DenseBudgetCaps { global: number; continental: number; regional: number; local: number }

/** Default caps per LOD band for a mid-range integrated GPU; the shell may lower them under `lowPower`. */
export const DEFAULT_DENSE_CAPS: DenseBudgetCaps = { global: 20_000, continental: 30_000, regional: 40_000, local: 50_000 };

export interface BudgetResult { kept: RenderFeature[]; dropped: number; cap: number }

/** Feature caps per LOD band. Over-budget sets keep the highest-priority features (stable by id). */
export class DenseBudget {
  private readonly caps: DenseBudgetCaps;
  constructor(caps: Partial<DenseBudgetCaps> = {}) {
    this.caps = { ...DEFAULT_DENSE_CAPS, ...caps };
  }
  capFor(band: LodBand): number { return this.caps[band]; }
  /** Scale every cap (e.g. 0.5 under low power). */
  scaled(factor: number): DenseBudget {
    const f = Math.max(0.05, factor);
    return new DenseBudget({ global: Math.round(this.caps.global * f), continental: Math.round(this.caps.continental * f), regional: Math.round(this.caps.regional * f), local: Math.round(this.caps.local * f) });
  }
  apply(features: RenderFeature[], band: LodBand): BudgetResult {
    const cap = this.capFor(band);
    if (features.length <= cap) return { kept: features, dropped: 0, cap };
    const kept = [...features].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, cap);
    return { kept, dropped: features.length - cap, cap };
  }
}

export interface NativeDenseAdapterOptions {
  kind: DenseKind;
  renderer: WorldRenderer;
  /** Presentation layer id the dense features belong to (replaced wholesale on every update). */
  layer: string;
  budget?: DenseBudget;
  band?: () => LodBand;
  /** Feature count above which this adapter declares itself unsuitable (deck.gl trigger). */
  nativeLimit?: number;
}

/** Delegates to the active WorldRenderer with `replaceLayers`, after applying the budget. */
export class NativeDenseAdapter implements DenseLayerRenderer {
  readonly kind: DenseKind;
  private readonly renderer: WorldRenderer;
  private readonly layer: string;
  private readonly budget: DenseBudget;
  private readonly band: () => LodBand;
  private readonly nativeLimit: number;
  private lastResult: BudgetResult | undefined;
  private disposed = false;

  constructor(options: NativeDenseAdapterOptions) {
    this.kind = options.kind;
    this.renderer = options.renderer;
    this.layer = options.layer;
    this.budget = options.budget ?? new DenseBudget();
    this.band = options.band ?? (() => 'local');
    this.nativeLimit = options.nativeLimit ?? options.renderer.capabilities.maxFeatures;
  }

  supports(count: number): boolean { return count <= this.nativeLimit; }

  update(features: RenderFeature[]): void {
    if (this.disposed) return;
    const result = this.budget.apply(features.filter((f) => f.layer === this.layer), this.band());
    this.lastResult = result;
    const update: FeatureUpdate = { upsert: result.kept, remove: [], replaceLayers: [this.layer] };
    this.renderer.update(update);
  }

  get last(): BudgetResult | undefined { return this.lastResult; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.clear(this.layer);
  }
}
