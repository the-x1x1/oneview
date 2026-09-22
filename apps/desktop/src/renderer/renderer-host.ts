import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type {
  AttributionEntry,
  BasemapDescriptor,
  FeatureUpdate,
  LensDefinition,
  RenderMode,
  RendererEvents,
  TerrainDescriptor,
  ViewState,
  WorldRenderer,
} from '@worldview/render-core';
import { resolveRenderMode, type HostCapabilities } from '@worldview/render-core';
import type { RendererHostEvents, RendererHostLike } from './renderer-host-like.js';

/**
 * The production renderer host: the Cesium globe and the MapLibre map, one mounted at a
 * time, behind the interface the shell codes against.
 *
 * Until this existed, `resolveHost()` fell back to the demo canvas host in *every* build,
 * so a packaged WORLDVIEW had neither renderer — the adapters were written, tested and
 * never composed. The two halves were also built to different shapes: `RendererHost` in
 * render-core presents a world snapshot itself, while the shell runs the presentation
 * pipeline and pushes a `FeatureUpdate`. This adapter is the join, and it is deliberately
 * thin: it owns the two renderers, the mode switch, and the state that has to survive a
 * switch (features, view, selection, lens, basemap, attribution).
 *
 * Renderers are constructed lazily, because constructing the Cesium viewer costs a WebGL
 * context and a user who never leaves 2D should never pay for one.
 */
export interface DesktopRendererHostOptions {
  /** Factories, so neither library is imported until its mode is actually used. */
  create2D: () => Promise<WorldRenderer>;
  create3D: () => Promise<WorldRenderer>;
  capabilities: HostCapabilities;
  mode?: RenderMode;
  initialView?: ViewState;
  onError?: (error: RendererEvents['error']) => void;
}

type Listener<K extends keyof RendererHostEvents> = (payload: RendererHostEvents[K]) => void;

export class DesktopRendererHost implements RendererHostLike {
  private container: HTMLElement | undefined;
  private readonly panes: Partial<Record<'2D' | '3D', HTMLElement>> = {};
  private readonly renderers: Partial<Record<'2D' | '3D', WorldRenderer>> = {};
  private readonly pending: Partial<Record<'2D' | '3D', Promise<WorldRenderer>>> = {};
  private readonly listeners = new Map<keyof RendererHostEvents, Set<(payload: never) => void>>();
  private readonly unsubs: Array<() => void> = [];

  private requested: RenderMode;
  private active: '2D' | '3D';
  private caps: HostCapabilities;
  /**
   * Monotonic token for {@link activate}. Two switches can be in flight at once — a
   * user double-clicking the 2D/3D toggle is enough — and the slower one must not
   * reveal its pane after the faster one has settled.
   */
  private activation = 0;
  /**
   * The mode the host is heading for, which is not `active` while a switch is in flight.
   * Comparing against `active` alone let a second `setMode` back to the current mode be
   * dismissed as a no-op while the first switch was still building, so the host settled
   * on the mode the user had just left.
   */
  private targetMode: '2D' | '3D';

  // State that must survive a mode switch: a renderer constructed later has to be
  // brought up to the same picture as the one it replaces.
  private features = new Map<string, import('@worldview/render-core').RenderFeature>();
  private view: ViewState;
  private selected: string | null = null;
  private attribution: AttributionEntry[] = [];
  private readonly basemaps: Partial<Record<'2D' | '3D', BasemapDescriptor>> = {};
  private terrain: TerrainDescriptor | undefined;

  constructor(private readonly options: DesktopRendererHostOptions) {
    this.caps = options.capabilities;
    this.requested = options.mode ?? 'AUTO';
    this.active = resolveRenderMode(this.requested, this.caps);
    this.targetMode = this.active;
    this.view = options.initialView ?? {
      center: { latitude: 20, longitude: 0 },
      altitudeM: 20_000_000,
      zoom: 2,
      headingDegrees: 0,
      pitchDegrees: -90,
    };
  }

  async mount(container: HTMLElement): Promise<void> {
    this.container = container;
    await this.activate(this.active);
  }

  unmount(): void {
    for (const off of this.unsubs.splice(0)) off();
    for (const mode of ['2D', '3D'] as const) {
      this.renderers[mode]?.dispose();
      delete this.renderers[mode];
      delete this.pending[mode];
      this.panes[mode]?.remove();
      delete this.panes[mode];
    }
    this.container = undefined;
  }

  setMode(mode: RenderMode): void {
    this.requested = mode;
    const next = resolveRenderMode(mode, this.caps);
    if (next === this.targetMode && this.renderers[next] && next === this.active) return;
    void this.activate(next);
  }

  activeMode(): '2D' | '3D' {
    return this.active;
  }

  supportsMode(mode: '2D' | '3D'): boolean {
    // 3D needs a WebGL2 context; 2D is always available.
    return mode === '2D' || this.caps.webgl2;
  }

  /**
   * The active renderer's own feature ceiling. Before a renderer is constructed there is
   * nothing to ask, and the shell's performance governor treats the absent answer as
   * "no ceiling of mine" — its ladder has one of its own.
   */
  maxFeatures(): number {
    return this.renderers[this.active]?.capabilities.maxFeatures ?? Number.POSITIVE_INFINITY;
  }

  setCapabilities(caps: HostCapabilities): void {
    this.caps = caps;
    const next = resolveRenderMode(this.requested, caps);
    if (next !== this.targetMode) void this.activate(next);
  }

  getView(): ViewState {
    const renderer = this.renderers[this.active];
    return renderer ? renderer.getView() : this.view;
  }

  async flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts?: { durationMs?: number },
  ): Promise<void> {
    const renderer = this.renderers[this.active];
    if (!renderer) return;
    await renderer.flyTo(target, opts);
    this.view = renderer.getView();
  }

  select(featureId: string | null): void {
    this.selected = featureId;
    this.renderers[this.active]?.select(featureId);
  }

  setLens(_lens: LensDefinition): void {
    // Lens visibility is applied by the shell's presentation pass before setFeatures;
    // a renderer draws exactly what it is given and knows nothing about lenses.
  }

  setFeatures(update: FeatureUpdate): void {
    for (const id of update.remove) this.features.delete(id);
    for (const feature of update.upsert) this.features.set(feature.id, feature);
    this.renderers[this.active]?.update(update);
  }

  setAttribution(entries: AttributionEntry[]): void {
    this.attribution = entries;
    this.renderers[this.active]?.setAttribution(entries);
  }

  async setBasemap(basemap: BasemapDescriptor, forMode?: '2D' | '3D'): Promise<void> {
    const mode = forMode ?? this.active;
    this.basemaps[mode] = basemap;
    if (mode === this.active) await this.renderers[mode]?.setBasemap(basemap);
  }

  async setTerrain(terrain: TerrainDescriptor): Promise<void> {
    this.terrain = terrain;
    await this.renderers['3D']?.setTerrain?.(terrain);
  }

  on<K extends keyof RendererHostEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set.delete(listener as (payload: never) => void);
    };
  }

  private emit<K extends keyof RendererHostEvents>(event: K, payload: RendererHostEvents[K]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) (l as (p: RendererHostEvents[K]) => void)(payload);
  }

  /** Bring a mode up, move the picture across, and suspend the one being left. */
  private async activate(mode: '2D' | '3D'): Promise<void> {
    this.targetMode = mode;
    if (!this.container) {
      this.active = mode;
      return;
    }
    const token = ++this.activation;
    const previous = this.active;
    if (previous !== mode) this.view = this.getView();

    let renderer: WorldRenderer;
    try {
      renderer = await this.renderer(mode);
    } catch (error) {
      // A renderer that will not construct is reported, and the mode does not change:
      // saying "3D" while showing nothing would be worse than staying in 2D.
      const failure = { message: error instanceof Error ? error.message : String(error), fatal: true };
      if (token === this.activation) {
        this.options.onError?.(failure);
        this.emit('error', failure);
      }
      return;
    }
    // Superseded while we were building. The renderer stays built for next time, but its
    // pane was created hidden and must remain so, and it must not draw behind the winner.
    if (token !== this.activation) {
      renderer.suspend();
      return;
    }

    if (previous !== mode) this.renderers[previous]?.suspend();
    this.active = mode;
    // Announce the switch. Activation is asynchronous — the renderer has to be imported,
    // constructed and mounted — so a caller that reads activeMode() straight after
    // setMode() reads the mode being left, not the one arriving. actions.setMode did
    // exactly that and wrote the stale answer back into the store, which is why clicking
    // 2D left the toggle showing 3D however well the switch had gone.
    this.emit('modeChanged', { mode, requested: this.requested });

    const pane = this.panes[mode]!;
    pane.style.display = '';
    if (this.panes[previous] && previous !== mode) this.panes[previous]!.style.display = 'none';

    renderer.resume();

    // The world's data goes in FIRST, and is not awaited behind the basemap.
    //
    // These four calls used to sit after `await setBasemap(...)`, so a basemap that never
    // finished loading took the objects, the attribution, the selection and the camera
    // with it — an empty map rather than a map without a backdrop. Both adapters accept
    // features before their style is ready and replay them when it is (MapLibre queues in
    // SourceModel and restores on style.load; Cesium's collections do not depend on
    // imagery at all), so there was never a reason to serialise them.
    if (this.features.size) renderer.update({ upsert: [...this.features.values()], remove: [] });
    renderer.setAttribution(this.attribution);
    renderer.select(this.selected);
    renderer.setView(this.view);

    const basemap = this.basemaps[mode];
    if (basemap) await renderer.setBasemap(basemap).catch(() => undefined);
    if (token !== this.activation) return;
    if (mode === '3D' && this.terrain) await renderer.setTerrain?.(this.terrain).catch(() => undefined);
  }

  /** Construct (once) and mount a renderer into its own pane. */
  private renderer(mode: '2D' | '3D'): Promise<WorldRenderer> {
    const existing = this.renderers[mode];
    if (existing) return Promise.resolve(existing);
    const inFlight = this.pending[mode];
    if (inFlight) return inFlight;

    const build = (async (): Promise<WorldRenderer> => {
      const pane = this.container!.ownerDocument.createElement('div');
      pane.className = `wv-renderer wv-renderer--${mode.toLowerCase()}`;
      pane.style.position = 'absolute';
      pane.style.inset = '0';
      // Hidden until activate() reveals it: a build that loses a race must not paint
      // over the mode the user actually settled on.
      pane.style.display = 'none';
      this.container!.appendChild(pane);
      this.panes[mode] = pane;

      const renderer = mode === '2D' ? await this.options.create2D() : await this.options.create3D();
      await renderer.mount(pane);
      this.renderers[mode] = renderer;
      for (const event of ['pick', 'hover', 'viewChanged', 'error'] as const) {
        this.unsubs.push(
          renderer.on(event, (payload) => {
            // A suspended MapLibre map can still settle and fire `moveend`, and a hidden
            // Cesium scene can still resolve a pick. Neither is on screen, so neither may
            // move the camera the shell is showing or change what is selected.
            if (this.active !== mode) return;
            if (event === 'viewChanged') this.view = payload as ViewState;
            this.emit(event, payload as never);
          }),
        );
      }
      return renderer;
    })();

    this.pending[mode] = build;
    build.catch(() => {
      delete this.pending[mode];
      this.panes[mode]?.remove();
      delete this.panes[mode];
    });
    return build;
  }
}
