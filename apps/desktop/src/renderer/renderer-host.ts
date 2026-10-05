import type { GeoBounds, GeoPosition, RasterOverlay } from '@worldview/world-model';
import type {
  AttributionEntry,
  BasemapDescriptor,
  ReferenceData,
  ReferenceOptions,
  FeatureUpdate,
  FlyToOptions,
  GraphicsProfile,
  ImagerySplit,
  LensDefinition,
  RenderMode,
  RendererEvents,
  ScreenPoint,
  TerrainDescriptor,
  ViewState,
  VisualStyleId,
  WorldRenderer,
} from '@worldview/render-core';
import { resolveRenderMode, viewForMode, type HostCapabilities } from '@worldview/render-core';
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
  /** GPU cost profile to build the first renderer with (render-core graphics.ts). */
  graphics?: GraphicsProfile;
  onError?: (error: RendererEvents['error']) => void;
  /** Timer for the rebuild after a lost WebGL context; setTimeout unless a test drives it. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
}

/** How long a map left on a 2D/3D switch stays built, below High quality, before it is released. */
export const RELEASE_HIDDEN_AFTER_MS = 2 * 60_000;

/**
 * A lost WebGL context — the GPU process crashed or the graphics driver reset — takes every
 * context in the window with it, and neither engine comes back from it: on 2026-09-29 the
 * laptop's GPU process exited (code 34) on a switch to the globe and the map stayed a dead
 * picture under "The renderer could not start" until the app was restarted. The host now
 * throws both renderers away and builds the one on screen again, where the camera was, after
 * CONTEXT_RECOVERY_DELAY_MS (Chromium starts a new GPU process meanwhile). Up to
 * CONTEXT_RECOVERIES times in CONTEXT_RECOVERY_WINDOW_MS; a driver that keeps failing is then
 * reported as fatal rather than rebuilt in a loop.
 */
export const CONTEXT_RECOVERY_DELAY_MS = 1500;
export const CONTEXT_RECOVERIES = 3;
export const CONTEXT_RECOVERY_WINDOW_MS = 10 * 60_000;

type Listener<K extends keyof RendererHostEvents> = (payload: RendererHostEvents[K]) => void;

/**
 * Every renderer event the shell can subscribe to, forwarded from whichever renderer is
 * active.
 *
 * This was a literal list of four — pick, hover, viewChanged, error — and `frame` was not on
 * it. The shell's performance governor and its `[perf]` log both listen for `frame`, so the
 * adaptive render budget was written, tested against render-core's `RendererHost` (which
 * does forward it), and never once ran in the desktop app, because this is the host the app
 * actually uses. The exhaustiveness check below turns the next omission into a compile
 * error instead of a feature that silently does nothing.
 *
 * `ready` is the one deliberate exception: the host's own `mount()` promise is its ready
 * signal, and a renderer built later (the second mode) must not announce the host again.
 */
const FORWARDED_EVENTS = [
  'pick',
  'click',
  'contextMenu',
  'pointer',
  'hover',
  'viewChanged',
  'error',
  'frame',
  'cameraMode',
  'modelCredits',
] as const;
type ForwardedEvent = (typeof FORWARDED_EVENTS)[number];
type UnforwardedEvent = Exclude<keyof RendererEvents, ForwardedEvent | 'ready'>;
const everyRendererEventIsForwarded: [UnforwardedEvent] extends [never] ? true : UnforwardedEvent = true;
void everyRendererEventIsForwarded;

export class DesktopRendererHost implements RendererHostLike {
  private container: HTMLElement | undefined;
  private readonly panes: Partial<Record<'2D' | '3D', HTMLElement>> = {};
  private readonly renderers: Partial<Record<'2D' | '3D', WorldRenderer>> = {};
  private readonly pending: Partial<Record<'2D' | '3D', Promise<WorldRenderer>>> = {};
  private readonly listeners = new Map<keyof RendererHostEvents, Set<(payload: never) => void>>();
  private readonly unsubs: Partial<Record<'2D' | '3D', Array<() => void>>> = {};

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
  private reference: { data: ReferenceData | null; options: ReferenceOptions } | undefined;
  private overlays: readonly RasterOverlay[] = [];
  private imagerySplit: ImagerySplit | null = null;
  private graphics: GraphicsProfile | undefined;
  private visualStyle: VisualStyleId = 'standard';
  private dayNight = false;
  /** The time the shading is for when not live (the timeline's); undefined: now. */
  private dayNightAt: number | undefined;
  private recoveries: number[] = [];
  private recovering = false;

  constructor(private readonly options: DesktopRendererHostOptions) {
    this.caps = options.capabilities;
    this.requested = options.mode ?? 'AUTO';
    this.active = resolveRenderMode(this.requested, this.caps);
    this.targetMode = this.active;
    this.graphics = options.graphics;
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
    for (const mode of ['2D', '3D'] as const) this.cancelRelease(mode);
    for (const mode of ['2D', '3D'] as const) {
      for (const off of this.unsubs[mode]?.splice(0) ?? []) off();
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

  setView(view: Partial<ViewState>, opts?: { animate?: boolean; durationMs?: number }): void {
    const renderer = this.renderers[this.active];
    if (!renderer) return;
    renderer.setView(view, opts);
    this.view = renderer.getView();
  }

  async flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts?: FlyToOptions,
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

  /** Borders and names: kept for a renderer built later, handed to both that exist now. */
  setReference(data: ReferenceData | null, options: ReferenceOptions): void {
    this.reference = { data, options };
    for (const mode of ['2D', '3D'] as const) this.renderers[mode]?.setReference?.(data, options);
  }

  /** Raster overlays: kept for a renderer built later, handed to both that exist now. */
  setOverlays(overlays: readonly RasterOverlay[]): void {
    this.overlays = overlays;
    for (const mode of ['2D', '3D'] as const) this.renderers[mode]?.setOverlays?.(overlays);
  }

  /** Imagery comparison: kept for a renderer built later, handed to both that exist now. */
  setImagerySplit(split: ImagerySplit | null): void {
    this.imagerySplit = split;
    for (const mode of ['2D', '3D'] as const) this.renderers[mode]?.setImagerySplit?.(split);
  }

  /** GPU cost profile: kept for a renderer built later, handed to both that exist now. */
  setGraphics(profile: GraphicsProfile): void {
    this.graphics = profile;
    for (const mode of ['2D', '3D'] as const) this.renderers[mode]?.setGraphics?.(profile);
  }

  /** Visual style: kept for a renderer built later, handed to both that exist now. */
  setVisualStyle(id: VisualStyleId): void {
    this.visualStyle = id;
    for (const mode of ['2D', '3D'] as const) this.renderers[mode]?.setVisualStyle?.(id);
  }

  /** Day/night shading (at `atMs`, or now): kept for a renderer built later, handed to both that exist now. */
  setDayNight(on: boolean, atMs?: number): void {
    this.dayNight = on;
    this.dayNightAt = atMs;
    for (const mode of ['2D', '3D'] as const) this.renderers[mode]?.setDayNight?.(on, atMs);
  }

  /**
   * Orbit and follow belong to the camera on screen: only the active renderer is told, and
   * a mode switch ends them (the renderer being left is suspended, which ends its modes and
   * says so through `cameraMode`).
   */
  setOrbit(on: boolean): void {
    this.renderers[this.active]?.setOrbit?.(on);
  }

  follow(featureId: string | null, opts?: { durationMs?: number }): void {
    this.renderers[this.active]?.follow?.(featureId, opts);
  }

  /** Positions on the renderer on screen; none while a switch is still building it. */
  project(positions: readonly GeoPosition[]): Array<ScreenPoint | null> {
    const renderer = this.renderers[this.active];
    return renderer?.project ? renderer.project(positions) : positions.map(() => null);
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

    if (previous !== mode) {
      this.renderers[previous]?.suspend();
      if (this.releasesHidden()) this.releaseLater(previous);
    }
    this.cancelRelease(mode);
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
    if (this.reference) renderer.setReference?.(this.reference.data, this.reference.options);
    if (this.overlays.length) renderer.setOverlays?.(this.overlays);
    if (this.imagerySplit) renderer.setImagerySplit?.(this.imagerySplit);
    renderer.select(this.selected);
    // The same ground in the middle of the screen in either mode (render-core view-handover.ts).
    renderer.setView(previous !== mode ? viewForMode(this.view, mode) : this.view);

    const basemap = this.basemaps[mode];
    if (basemap) await renderer.setBasemap(basemap).catch(() => undefined);
    if (token !== this.activation) return;
    if (mode === '3D' && this.terrain) await renderer.setTerrain?.(this.terrain).catch(() => undefined);
  }

  /**
   * Below High quality a renderer left hidden for RELEASE_HIDDEN_AFTER_MS is thrown away rather
   * than kept suspended: a suspended one still holds its WebGL context and every texture in it,
   * and an integrated GPU shares that memory with everything else. On 2026-09-29 the laptop's GPU
   * process died on a switch back to the globe with the 2D map still holding its context.
   * Released at once, every switch rebuilt a renderer, and the window's JavaScript heap grew by
   * tens of megabytes a round trip (an hour of switching on the laptop): a quick switch back now
   * finds it as it was, and one after a while builds it again (a second or two). On High both
   * stay, for instant switches.
   */
  private releasesHidden(): boolean {
    return this.graphics !== undefined && this.graphics.quality !== 'high';
  }

  private readonly releaseTimers: Partial<Record<'2D' | '3D', unknown>> = {};

  private releaseLater(mode: '2D' | '3D'): void {
    this.cancelRelease(mode);
    const schedule = this.options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.releaseTimers[mode] = schedule(() => {
      delete this.releaseTimers[mode];
      if (this.active !== mode && this.targetMode !== mode) this.release(mode);
    }, RELEASE_HIDDEN_AFTER_MS);
  }

  private cancelRelease(mode: '2D' | '3D'): void {
    const t = this.releaseTimers[mode];
    if (t === undefined) return;
    delete this.releaseTimers[mode];
    (this.options.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(t);
  }

  private release(mode: '2D' | '3D'): void {
    for (const off of this.unsubs[mode]?.splice(0) ?? []) off();
    try {
      this.renderers[mode]?.dispose();
    } catch {
      // dropped either way
    }
    delete this.renderers[mode];
    delete this.pending[mode];
    this.panes[mode]?.remove();
    delete this.panes[mode];
  }

  /** The WebGL context went: rebuild (CONTEXT_RECOVERY_DELAY_MS), or give up if it keeps going. */
  private contextLost(): void {
    if (this.recovering || !this.container) return;
    const now = (this.options.now ?? Date.now)();
    this.recoveries = this.recoveries.filter((t) => now - t < CONTEXT_RECOVERY_WINDOW_MS);
    if (this.recoveries.length >= CONTEXT_RECOVERIES) {
      const failure = {
        message: `The graphics driver reset ${CONTEXT_RECOVERIES + 1} times in ${CONTEXT_RECOVERY_WINDOW_MS / 60_000} minutes; restart WorldView, or lower Settings → Rendering → Graphics quality`,
        fatal: true,
      };
      this.options.onError?.(failure);
      this.emit('error', failure);
      return;
    }
    this.recoveries.push(now);
    this.recovering = true;
    this.emit('error', { message: 'The graphics driver reset; the map is being rebuilt', fatal: false });
    const schedule = this.options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    schedule(() => {
      this.recovering = false;
      this.rebuild();
    }, CONTEXT_RECOVERY_DELAY_MS);
  }

  /** Both renderers thrown away (their contexts are dead), the one on screen built again. */
  private rebuild(): void {
    if (!this.container) return;
    // A renderer whose context is gone may fail to tidy up; release() drops it either way.
    for (const mode of ['2D', '3D'] as const) this.release(mode);
    // The mode being left must not be the one activate() thinks it is leaving: nothing is built.
    this.active = this.targetMode;
    void this.activate(this.targetMode);
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
      // Before mount: antialiasing and MSAA are fixed when the WebGL context is created.
      if (this.graphics) renderer.setGraphics?.(this.graphics);
      // The looks the operator chose, in place from the first frame (both renderers keep them
      // until they mount).
      renderer.setVisualStyle?.(this.visualStyle);
      renderer.setDayNight?.(this.dayNight, this.dayNightAt);
      await renderer.mount(pane);
      this.renderers[mode] = renderer;
      for (const event of FORWARDED_EVENTS) {
        (this.unsubs[mode] ??= []).push(
          renderer.on(event, (payload) => {
            // A lost context is the window's, not one renderer's: whichever says it first.
            if (event === 'error' && (payload as RendererEvents['error']).contextLost) {
              this.contextLost();
              return;
            }
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
