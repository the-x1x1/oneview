import type { FeatureUpdate, RenderFeature } from '@worldview/render-core';

/**
 * Hands feature changes to the renderer a slice per frame, instead of all at once.
 *
 * The satellite catalogue is re-propagated every fifteen seconds, which moves all ~5,000
 * satellites in one presentation pass. Applying that as one update cost the renderer a
 * single 15–37 ms frame on the operator's machine (median ~19 ms, from the app's own perf
 * log) — one visible hitch per refresh, and proportionally worse on a slower machine. The
 * same number of changes spread over two or three frames costs nothing visible.
 *
 * Changes are merged latest-wins per feature id: a feature that moves twice before it is
 * drained is sent once, at its latest position, and one that is removed after being
 * queued is sent as a removal. So the renderer always converges on the most recent
 * presentation, however far behind the drain is — it can be late, never wrong. Removing an
 * id the renderer never received is a no-op in both adapters.
 */
export interface FeatureFeedOptions {
  /** Features handed over per step inside a drain. */
  chunk?: number;
  /** Stop draining once a frame has spent this long (at least one chunk always goes). */
  budgetMs?: number;
  now?: () => number;
}

export interface DrainResult {
  applied: number;
  ms: number;
  backlog: number;
}

export class FeatureFeed {
  private readonly pending = new Map<string, RenderFeature | null>();
  private readonly chunk: number;
  private readonly budgetMs: number;
  private readonly now: () => number;

  constructor(
    private readonly sink: (update: FeatureUpdate) => void,
    options: FeatureFeedOptions = {},
  ) {
    this.chunk = Math.max(1, options.chunk ?? 500);
    this.budgetMs = Math.max(0, options.budgetMs ?? 6);
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  get backlog(): number {
    return this.pending.size;
  }

  /** Merge a diff into what is waiting. Later changes to an id replace earlier ones. */
  enqueue(update: FeatureUpdate): void {
    for (const id of update.remove) {
      this.pending.delete(id);
      this.pending.set(id, null);
    }
    for (const f of update.upsert) {
      // Re-inserting moves the id to the back, so an id that keeps changing does not starve
      // the ones queued behind it.
      this.pending.delete(f.id);
      this.pending.set(f.id, f);
    }
  }

  /** Hand over as much as fits in this frame's budget. */
  drain(): DrainResult {
    const started = this.now();
    let applied = 0;
    while (this.pending.size > 0) {
      const upsert: RenderFeature[] = [];
      const remove: string[] = [];
      for (const [id, f] of this.pending) {
        if (f) upsert.push(f);
        else remove.push(id);
        this.pending.delete(id);
        if (upsert.length + remove.length >= this.chunk) break;
      }
      this.sink({ upsert, remove });
      applied += upsert.length + remove.length;
      if (this.now() - started >= this.budgetMs) break;
    }
    return { applied, ms: this.now() - started, backlog: this.pending.size };
  }

  /** Hand over everything now, whatever it costs. */
  flush(): number {
    if (this.pending.size === 0) return 0;
    const upsert: RenderFeature[] = [];
    const remove: string[] = [];
    for (const [id, f] of this.pending) {
      if (f) upsert.push(f);
      else remove.push(id);
    }
    this.pending.clear();
    this.sink({ upsert, remove });
    return upsert.length + remove.length;
  }

  clear(): void {
    this.pending.clear();
  }
}
