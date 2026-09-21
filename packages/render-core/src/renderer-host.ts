import type { WorldEvent, WorldObject } from '@worldview/world-model';
import type { AttributionEntry, BasemapDescriptor, FeatureUpdate, PickResult, RenderFeature, RenderMode, RendererEvents, TerrainDescriptor, ViewState, WorldRenderer } from './contract.js';
import type { LensDefinition } from './lenses.js';
import { DEFAULT_RULES, diffFeatures, presentObjects, type PresentationResult, type RenderingRule } from './presentation.js';
import { InThreadPresentationWorker, toPresentationInput, type PresentationRequest, type PresentationWorker } from './presentation-worker.js';
import { createFrameScheduler, FrameCoalescer, type FrameScheduler } from './scheduler.js';

/**
 * RendererHost — owns the 2D and 3D adapters, keeps ViewState / selection / lens in
 * sync across them (directive §49), suspends the hidden one, and drives the
 * presentation pipeline at most once per animation frame, off-thread above a
 * configurable object count. Pure orchestration: no DOM beyond the container
 * elements handed to `WorldRenderer.mount`.
 */
export interface HostCapabilities {
  webgl2: boolean;
  /** Battery saver / integrated-GPU hint from the shell. */
  lowPower?: boolean;
  offline?: boolean;
  /** Terrain usable offline (local pack) or online (token). */
  terrainAvailable?: boolean;
  /** What the user chose for offline sessions in settings. */
  offlineModePreference?: '2D' | '3D';
}

/** AUTO resolves to 2D when the machine or the situation does not justify the globe. */
export function resolveRenderMode(requested: RenderMode, caps: HostCapabilities): '2D' | '3D' {
  if (requested !== 'AUTO') return requested;
  if (!caps.webgl2 || caps.lowPower) return '2D';
  if (caps.offline && caps.offlineModePreference === '2D' && !caps.terrainAvailable) return '2D';
  return '3D';
}

/**
 * `WorldRenderer.setTerrain` is an optional contract method (ADR-008), so the host calls
 * it directly with optional chaining rather than duck-typing the renderer.
 */
export type TerrainCapableRenderer = WorldRenderer & { setTerrain(terrain: TerrainDescriptor): Promise<void> };
export function isTerrainCapable(r: WorldRenderer): r is TerrainCapableRenderer {
  return typeof r.setTerrain === 'function';
}

export interface WorldSnapshot {
  objects: WorldObject[];
  events?: WorldEvent[];
  selectedTrack?: Array<{ latitude: number; longitude: number; altitudeM?: number }>;
}

export interface RendererHostOptions {
  renderers: { '2D': () => WorldRenderer; '3D': () => WorldRenderer };
  containers: { '2D': HTMLElement; '3D': HTMLElement };
  capabilities: HostCapabilities;
  mode?: RenderMode;
  worker?: PresentationWorker;
  /** Object count above which presentation runs on the worker (default 5,000). */
  workerThreshold?: number;
  scheduler?: FrameScheduler;
  rules?: RenderingRule[];
  maxFeatures?: number;
  initialView?: ViewState;
}

export interface HostEvents {
  pick: PickResult | null;
  hover: PickResult | null;
  viewChanged: ViewState;
  modeChanged: { mode: '2D' | '3D'; requested: RenderMode };
  presented: PresentationResult['stats'] & { upserts: number; removes: number; offThread: boolean };
  error: RendererEvents['error'];
}

const DEFAULT_VIEW: ViewState = { center: { latitude: 20, longitude: 0 }, altitudeM: 20_000_000, zoom: 1.5, headingDegrees: 0, pitchDegrees: -90 };

export class RendererHost {
  private readonly instances: Partial<Record<'2D' | '3D', WorldRenderer>> = {};
  private readonly mounted = new Set<WorldRenderer>();
  private readonly listeners: { [K in keyof HostEvents]?: Set<(p: HostEvents[K]) => void> } = {};
  private readonly rendererUnsubs: Array<() => void> = [];
  private readonly coalescer: FrameCoalescer;
  private readonly worker: PresentationWorker;
  private readonly ownsWorker: boolean;
  private readonly workerThreshold: number;
  private readonly basemaps: Partial<Record<'2D' | '3D', BasemapDescriptor>> = {};
  private terrain: TerrainDescriptor | undefined;
  private attribution: AttributionEntry[] = [];
  private features = new Map<string, RenderFeature>();
  private world: WorldSnapshot = { objects: [] };
  private view: ViewState;
  private lens: LensDefinition | undefined;
  private rules: RenderingRule[];
  private readonly maxFeatures: number | undefined;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private requested: RenderMode;
  private active: WorldRenderer | undefined;
  private activeMode: '2D' | '3D' | undefined;
  private caps: HostCapabilities;
  private presentGen = 0;
  private inFlight = false;
  private dirty = false;
  private suspended = false;
  private disposed = false;

  constructor(private readonly options: RendererHostOptions) {
    this.caps = options.capabilities;
    this.requested = options.mode ?? 'AUTO';
    this.view = options.initialView ?? DEFAULT_VIEW;
    this.rules = options.rules ?? DEFAULT_RULES;
    this.maxFeatures = options.maxFeatures;
    this.worker = options.worker ?? new InThreadPresentationWorker();
    this.ownsWorker = !options.worker;
    this.workerThreshold = options.workerThreshold ?? 5_000;
    this.coalescer = new FrameCoalescer(options.scheduler ?? createFrameScheduler(), () => { void this.presentNow(); });
  }

  get mode(): '2D' | '3D' | undefined { return this.activeMode; }
  get requestedMode(): RenderMode { return this.requested; }
  get renderer(): WorldRenderer | undefined { return this.active; }
  get featureCount(): number { return this.features.size; }
  get selected(): string | null { return this.selectedId; }
  feature(id: string): RenderFeature | undefined { return this.features.get(id); }
  /** Feature id for an object/event id in the current presentation. */
  featureIdFor(id: string | null): string | null {
    if (!id) return null;
    if (this.features.has(`obj:${id}`)) return `obj:${id}`;
    if (this.features.has(`event:${id}`)) return `event:${id}`;
    return null;
  }

  on<K extends keyof HostEvents>(event: K, listener: (payload: HostEvents[K]) => void): () => void {
    let set = this.listeners[event] as Set<(p: HostEvents[K]) => void> | undefined;
    if (!set) { set = new Set(); (this.listeners as Record<string, unknown>)[event] = set; }
    set.add(listener);
    return () => { set!.delete(listener); };
  }
  private emit<K extends keyof HostEvents>(event: K, payload: HostEvents[K]): void {
    const set = this.listeners[event] as Set<(p: HostEvents[K]) => void> | undefined;
    if (set) for (const l of [...set]) l(payload);
  }

  /** Mount the renderer for the current mode. */
  async start(): Promise<void> {
    await this.setMode(this.requested);
  }

  async setMode(mode: RenderMode): Promise<void> {
    if (this.disposed) return;
    this.requested = mode;
    const resolved = resolveRenderMode(mode, this.caps);
    if (resolved === this.activeMode && this.active) return;
    const previous = this.active;
    if (previous) this.view = previous.getView();
    const next = await this.ensureMounted(resolved);
    if (this.disposed) return;
    // Sync state into the incoming renderer before it becomes visible (§49).
    next.setView(this.view, { animate: false });
    next.setAttribution(this.attribution);
    const basemap = this.basemaps[resolved];
    if (basemap) await next.setBasemap(basemap).catch((err: unknown) => this.emit('error', { message: `basemap: ${errorMessage(err)}`, fatal: false }));
    if (this.terrain) await next.setTerrain?.(this.terrain).catch((err: unknown) => this.emit('error', { message: `terrain: ${errorMessage(err)}`, fatal: false }));
    next.clear();
    if (this.features.size) next.update({ upsert: [...this.features.values()], remove: [] });
    next.select(this.featureIdFor(this.selectedId));
    this.detachRendererEvents();
    if (previous && previous !== next) previous.suspend();
    this.active = next;
    this.activeMode = resolved;
    this.attachRendererEvents(next);
    if (!this.suspended) next.resume();
    this.emit('modeChanged', { mode: resolved, requested: mode });
  }

  setCapabilities(caps: HostCapabilities): void {
    this.caps = caps;
    if (this.requested === 'AUTO') void this.setMode('AUTO');
  }

  private async ensureMounted(mode: '2D' | '3D'): Promise<WorldRenderer> {
    let r = this.instances[mode];
    if (!r) { r = this.options.renderers[mode](); this.instances[mode] = r; }
    if (!this.mounted.has(r)) { await r.mount(this.options.containers[mode]); this.mounted.add(r); }
    return r;
  }

  private attachRendererEvents(r: WorldRenderer): void {
    this.rendererUnsubs.push(
      r.on('viewChanged', (v) => { this.view = v; this.emit('viewChanged', v); this.requestPresent(); }),
      r.on('pick', (p) => this.emit('pick', p)),
      r.on('hover', (p) => { const id = p?.objectId ?? p?.eventId ?? null; if (id !== this.hoveredId) { this.hoveredId = id; this.requestPresent(); } this.emit('hover', p); }),
      r.on('error', (e) => this.emit('error', e)),
    );
  }
  private detachRendererEvents(): void {
    for (const u of this.rendererUnsubs.splice(0)) u();
  }

  // ── world / lens / selection inputs ────────────────────────────────────────
  setWorld(snapshot: WorldSnapshot): void { this.world = snapshot; this.requestPresent(); }
  setLens(lens: LensDefinition | undefined): void {
    this.lens = lens;
    this.rules = lens && lens.renderingRules.length ? lens.renderingRules : (this.options.rules ?? DEFAULT_RULES);
    this.requestPresent();
  }
  get activeLens(): LensDefinition | undefined { return this.lens; }
  select(objectOrEventId: string | null): void {
    if (objectOrEventId === this.selectedId) return;
    this.selectedId = objectOrEventId;
    this.active?.select(this.featureIdFor(objectOrEventId));
    this.requestPresent();
  }
  hover(objectOrEventId: string | null): void {
    if (objectOrEventId === this.hoveredId) return;
    this.hoveredId = objectOrEventId;
    this.requestPresent();
  }

  // ── view ───────────────────────────────────────────────────────────────────
  getView(): ViewState { return this.active ? this.active.getView() : this.view; }
  setView(view: Partial<ViewState>, opts?: { animate?: boolean; durationMs?: number }): void {
    this.view = { ...this.view, ...view };
    if (this.active) this.active.setView(view, opts); else this.requestPresent();
  }
  flyTo(target: Parameters<WorldRenderer['flyTo']>[0], opts?: { durationMs?: number }): Promise<void> {
    if (!this.active) { this.view = { ...this.view, center: target.position, ...(target.altitudeM !== undefined ? { altitudeM: target.altitudeM } : {}), ...(target.zoom !== undefined ? { zoom: target.zoom } : {}) }; return Promise.resolve(); }
    return this.active.flyTo(target, opts);
  }

  // ── basemap / terrain / attribution ────────────────────────────────────────
  async setBasemap(basemap: BasemapDescriptor, forMode?: '2D' | '3D'): Promise<void> {
    const mode = forMode ?? this.activeMode ?? resolveRenderMode(this.requested, this.caps);
    this.basemaps[mode] = basemap;
    if (this.active && mode === this.activeMode) await this.active.setBasemap(basemap);
  }
  async setTerrain(terrain: TerrainDescriptor): Promise<void> {
    this.terrain = terrain;
    await this.active?.setTerrain?.(terrain);
  }
  setAttribution(entries: AttributionEntry[]): void {
    this.attribution = entries;
    this.active?.setAttribution(entries);
  }

  // ── visibility ─────────────────────────────────────────────────────────────
  suspend(): void { this.suspended = true; this.active?.suspend(); }
  resume(): void { this.suspended = false; this.active?.resume(); this.requestPresent(); }

  // ── presentation ───────────────────────────────────────────────────────────
  requestPresent(): void {
    if (this.disposed) return;
    this.coalescer.schedule();
  }
  get presentationScheduled(): boolean { return this.coalescer.scheduled; }

  private buildRequest(): PresentationRequest {
    const req: PresentationRequest = { objects: this.world.objects, view: this.view, rules: this.rules, selectedId: this.selectedId, hoveredId: this.hoveredId };
    if (this.world.events) req.events = this.world.events;
    if (this.lens) req.visibleTypes = this.lens.objectTypes;
    if (this.world.selectedTrack) req.selectedTrack = this.world.selectedTrack;
    if (this.maxFeatures !== undefined) req.maxFeatures = this.maxFeatures;
    return req;
  }

  /** Run one presentation pass now (normally driven by the frame coalescer). */
  async presentNow(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) { this.dirty = true; return; }
    const gen = ++this.presentGen;
    const request = this.buildRequest();
    const offThread = request.objects.length > this.workerThreshold;
    let result: PresentationResult;
    try {
      if (offThread) {
        this.inFlight = true;
        result = await this.worker.present(request);
      } else {
        result = presentObjects(toPresentationInput(request));
      }
    } catch (err) {
      this.emit('error', { message: `presentation: ${errorMessage(err)}`, fatal: false });
      return;
    } finally {
      this.inFlight = false;
    }
    if (gen !== this.presentGen || this.disposed) { if (this.dirty) { this.dirty = false; this.requestPresent(); } return; }
    this.applyResult(result, offThread);
    if (this.dirty) { this.dirty = false; this.requestPresent(); }
  }

  private applyResult(result: PresentationResult, offThread: boolean): void {
    const update: FeatureUpdate = diffFeatures(this.features, result.upsert);
    const next = new Map<string, RenderFeature>();
    for (const f of result.upsert) next.set(f.id, f);
    this.features = next;
    if (this.active && (update.upsert.length || update.remove.length)) this.active.update(update);
    this.active?.select(this.featureIdFor(this.selectedId));
    this.emit('presented', { ...result.stats, upserts: update.upsert.length, removes: update.remove.length, offThread });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coalescer.cancel();
    this.detachRendererEvents();
    for (const r of Object.values(this.instances)) { try { r.dispose(); } catch { /* renderer already gone */ } }
    if (this.ownsWorker) this.worker.dispose();
    this.features.clear();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
