import type { AttributionEntry, BasemapDescriptor, FeatureUpdate, PickResult, RenderFeature, RendererCapabilities, RendererEvents, TerrainDescriptor, ViewState, WorldRenderer } from '../contract.js';
import { zoomToAltitudeM, altitudeToZoom } from '../contract.js';

/**
 * In-memory WorldRenderer for tests and demo/headless mode. Records every call,
 * keeps a feature map exactly as a real adapter would, and lets tests raise
 * renderer events. No DOM, no GPU.
 */
export class FakeWorldRenderer implements WorldRenderer {
  readonly capabilities: RendererCapabilities;
  readonly features = new Map<string, RenderFeature>();
  readonly calls: string[] = [];
  readonly updates: FeatureUpdate[] = [];
  container: HTMLElement | undefined;
  suspended = false;
  selected: string | null = null;
  attribution: AttributionEntry[] = [];
  basemap: BasemapDescriptor | undefined;
  terrain: TerrainDescriptor | undefined;
  disposed = false;
  private view: ViewState = { center: { latitude: 0, longitude: 0 }, altitudeM: 10_000_000, zoom: 2, headingDegrees: 0, pitchDegrees: -90 };
  private readonly listeners: { [K in keyof RendererEvents]?: Set<(p: RendererEvents[K]) => void> } = {};

  constructor(mode: '2D' | '3D', private readonly options: { withTerrain?: boolean; mountDelayMs?: number } = {}) {
    this.capabilities = { mode, terrain: mode === '3D', tilt: mode === '3D', clustering: mode === '2D', maxFeatures: 100_000 };
  }

  async mount(container: HTMLElement): Promise<void> {
    this.calls.push('mount');
    if (this.options.mountDelayMs) await new Promise((r) => setTimeout(r, this.options.mountDelayMs));
    this.container = container;
    this.emit('ready', undefined);
  }
  unmount(): void { this.calls.push('unmount'); this.container = undefined; }
  suspend(): void { this.calls.push('suspend'); this.suspended = true; }
  resume(): void { this.calls.push('resume'); this.suspended = false; }
  update(update: FeatureUpdate): void {
    this.calls.push('update');
    this.updates.push(update);
    if (update.replaceLayers) for (const [id, f] of this.features) if (update.replaceLayers.includes(f.layer)) this.features.delete(id);
    for (const id of update.remove) this.features.delete(id);
    for (const f of update.upsert) this.features.set(f.id, f);
  }
  clear(layer?: string): void {
    this.calls.push('clear');
    if (!layer) { this.features.clear(); return; }
    for (const [id, f] of this.features) if (f.layer === layer) this.features.delete(id);
  }
  setView(view: Partial<ViewState>, _opts?: { animate?: boolean; durationMs?: number }): void {
    this.calls.push('setView');
    const next = { ...this.view, ...view };
    if (view.zoom !== undefined && view.altitudeM === undefined) next.altitudeM = zoomToAltitudeM(view.zoom, next.center.latitude);
    if (view.altitudeM !== undefined && view.zoom === undefined) next.zoom = altitudeToZoom(view.altitudeM, next.center.latitude);
    this.view = next;
  }
  getView(): ViewState { return this.view; }
  async flyTo(target: { position: { latitude: number; longitude: number }; altitudeM?: number; zoom?: number }, _opts?: { durationMs?: number }): Promise<void> {
    this.calls.push('flyTo');
    this.setView({ center: target.position, ...(target.altitudeM !== undefined ? { altitudeM: target.altitudeM } : {}), ...(target.zoom !== undefined ? { zoom: target.zoom } : {}) });
    this.emit('viewChanged', this.view);
  }
  select(featureId: string | null): void { this.calls.push('select'); this.selected = featureId; }
  setAttribution(entries: AttributionEntry[]): void { this.calls.push('setAttribution'); this.attribution = entries; }
  async setBasemap(basemap: BasemapDescriptor): Promise<void> { this.calls.push('setBasemap'); this.basemap = basemap; }
  async setTerrain(terrain: TerrainDescriptor): Promise<void> {
    if (!this.options.withTerrain) throw new Error('terrain not supported by this fake');
    this.calls.push('setTerrain'); this.terrain = terrain;
  }
  on<K extends keyof RendererEvents>(event: K, listener: (payload: RendererEvents[K]) => void): () => void {
    let set = this.listeners[event] as Set<(p: RendererEvents[K]) => void> | undefined;
    if (!set) { set = new Set(); (this.listeners as Record<string, unknown>)[event] = set; }
    set.add(listener);
    return () => { set!.delete(listener); };
  }
  /** Test hook: raise a renderer event as the adapter would. */
  emit<K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]): void {
    const set = this.listeners[event] as Set<(p: RendererEvents[K]) => void> | undefined;
    if (set) for (const l of [...set]) l(payload);
  }
  listenerCount(event: keyof RendererEvents): number { return this.listeners[event]?.size ?? 0; }
  simulatePick(result: PickResult | null): void { this.emit('pick', result); }
  async screenshot(): Promise<Uint8Array> { this.calls.push('screenshot'); return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); }
  dispose(): void { this.calls.push('dispose'); this.disposed = true; this.features.clear(); }
}
