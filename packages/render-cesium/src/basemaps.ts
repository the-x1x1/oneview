/**
 * Adapted from gods-eye-view src/maps/controller.js, src/maps/registry.js and
 * src/maps/defaultSources.js (MIT).
 *
 * MapStackController coordinates imagery/tileset lifetimes and scene changes with
 * a generation counter so a late async result can never override a newer
 * selection. Imagery providers are cached per stack, construction failures fall
 * back to the declared stack, and repeated tile failures switch to the fallback
 * once (with the on-screen credit following the stack actually shown).
 *
 * WORLDVIEW differences: the default and the recovery stack are Natural Earth II
 * (bundled with Cesium, zero credentials, works offline); Esri / OSM are
 * selectable but conditional; Google 3D is an optional tileset stack that needs
 * a user-supplied key; terrain is controlled separately (see terrain.ts).
 */
import type { BasemapDescriptor } from '@worldview/render-core';
import type {
  CesiumLike,
  ImageryLayerCollectionLike,
  ImageryLayerLike,
  ImageryProviderLike,
  PrimitiveCollectionLike,
  TilesetLike,
} from './cesium-like.js';
import {
  createEsriWorldImagery,
  createIonImagery,
  createNaturalEarthImagery,
  createOsmImagery,
  createXyzImagery,
  ESRI_ATTRIBUTION,
  NATURAL_EARTH_ATTRIBUTION,
  OSM_ATTRIBUTION,
  type ImageryFactoryModule,
} from './imagery.js';
import {
  createGoogle3DTileset,
  google3dAvailability,
  GOOGLE_3D_ATTRIBUTION,
  type Google3DOptions,
} from './google3d.js';

export interface StackDescriptor {
  id: string;
  label: string;
  kind: 'imagery' | 'tileset' | 'none';
  attribution: string;
  /** Status in docs/legal/COMMERCIAL-DISTRIBUTION-REVIEW.md. Conditional stacks are never defaults. */
  review: 'approved' | 'conditional';
  offlineCapable: boolean;
  requires?: 'ion-token' | 'google-key';
}

export interface MapStackSource {
  descriptor: StackDescriptor;
  available: boolean;
  unavailableReason?: string;
  imagery?: (ctx: { signal: AbortSignal }) => Promise<ImageryProviderLike> | ImageryProviderLike;
  createTileset?: (ctx: { signal: AbortSignal }) => Promise<TilesetLike>;
  constructionFallback?: { id: string; message: string };
  tileFailureFallback?: { id: string; threshold: number; message: string };
}

export interface MapStackRegistry {
  defaultId: string;
  /** Activated when the requested stack fails outright. */
  recoveryId: string;
  sources: MapStackSource[];
}

export interface StackSummary extends StackDescriptor {
  available: boolean;
  unavailableReason: string | null;
}

export interface MapStackState {
  activeId: string;
  status: 'switching' | 'ready' | 'error';
  lastError: string | null;
  stacks: StackSummary[];
}

export interface StackViewerLike {
  imageryLayers: ImageryLayerCollectionLike;
  scene: { globe: { show: boolean }; primitives: PrimitiveCollectionLike; requestRender(): void };
}

export interface MapCreditsLike {
  show(html: string | null): void;
  destroy(): void;
}

export interface MapStackControllerOptions {
  registry: MapStackRegistry;
  initialStackId?: string;
  createImageryLayer: (provider: ImageryProviderLike) => ImageryLayerLike;
  credits: MapCreditsLike;
  onChange?: (state: MapStackState) => void;
  onError?: (message: string, stack: StackDescriptor) => void;
}

/** Catch invalid source graphs before a cached fallback can wait on itself. */
export function indexMapSources(sources: MapStackSource[]): Map<string, MapStackSource> {
  const index = new Map<string, MapStackSource>();
  for (const source of sources) {
    const id = source.descriptor.id;
    if (!id || index.has(id)) throw new TypeError('Map source IDs must be nonempty and unique');
    index.set(id, source);
  }
  for (const id of index.keys()) {
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next) {
      if (seen.has(next)) throw new TypeError('Map source fallback cycle');
      const src = index.get(next);
      if (!src) throw new TypeError('Unknown map fallback source');
      seen.add(next);
      next = src.constructionFallback?.id;
    }
  }
  return index;
}

interface ImageryResolution {
  provider: ImageryProviderLike;
  effectiveStackId: string;
  fallbackMessage: string | null;
}

/** The readable part of whatever a provider threw, short enough for a toast. */
function describeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed || 'no reason given';
}

export class MapStackController {
  private readonly sources: Map<string, MapStackSource>;
  private readonly abort = new AbortController();
  private readonly imageryProviders = new Map<string, Promise<ImageryResolution>>();
  private readonly tilesets = new Map<string, Promise<TilesetLike>>();
  private readonly ownedTilesets = new Set<TilesetLike>();
  private readonly disposedValues = new WeakSet<object>();
  private activeId: string;
  private switchGen = 0;
  private isSwitching = false;
  private lastError: string | null = null;
  private imageryLayer: ImageryLayerLike | null = null;
  private activeImageryProvider: ImageryProviderLike | null = null;
  private removeImageryErrorListener: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private readonly viewer: StackViewerLike,
    private readonly options: MapStackControllerOptions,
  ) {
    this.sources = indexMapSources(options.registry.sources);
    const initial = options.initialStackId;
    this.activeId = initial && this.isStackAvailable(initial) ? initial : options.registry.defaultId;
  }

  /** Add a stack at runtime (user-configured XYZ source). Replaces an existing id. */
  registerSource(source: MapStackSource): void {
    this.sources.set(source.descriptor.id, source);
    indexMapSources([...this.sources.values()]);
  }

  getStack(id: string): StackDescriptor | null {
    return this.sources.get(id)?.descriptor ?? null;
  }
  getStacks(): StackSummary[] {
    return [...this.sources.values()].map(({ descriptor }) => {
      const available = this.isStackAvailable(descriptor.id);
      return { ...descriptor, available, unavailableReason: available ? null : this.unavailableReason(descriptor) };
    });
  }
  isStackAvailable(id: string): boolean {
    const source = this.sources.get(id);
    return Boolean(source && source.available !== false);
  }
  private unavailableReason(stack: StackDescriptor): string {
    return this.sources.get(stack.id)?.unavailableReason ?? `${stack.label} is unavailable`;
  }
  getActiveId(): string {
    return this.activeId;
  }
  getActiveStack(): StackDescriptor | null {
    return this.getStack(this.activeId);
  }
  getSwitchGeneration(): number {
    return this.switchGen;
  }
  getState(status: MapStackState['status'] = this.isSwitching ? 'switching' : 'ready'): MapStackState {
    return { activeId: this.activeId, status, lastError: this.lastError, stacks: this.getStacks() };
  }
  private emitChange(status: MapStackState['status']): void {
    this.options.onChange?.(this.getState(status));
  }

  async setStack(id: string, { silent = false }: { silent?: boolean } = {}): Promise<MapStackState> {
    if (this.destroyed) return this.getState();
    const stack = this.getStack(id);
    if (!stack) {
      this.lastError = `Unknown map stack: ${id}`;
      this.options.onError?.(this.lastError, {
        id,
        label: id,
        kind: 'none',
        attribution: '',
        review: 'approved',
        offlineCapable: false,
      });
      return this.getState('error');
    }
    if (!this.isStackAvailable(stack.id)) {
      const message = this.unavailableReason(stack);
      this.lastError = message;
      this.options.onError?.(message, stack);
      return this.getState('error');
    }
    const gen = ++this.switchGen;
    this.isSwitching = true;
    this.lastError = null;
    if (!silent) this.emitChange('switching');
    try {
      const activation = await this.activate(stack, gen);
      if (gen !== this.switchGen) return this.getState();
      this.activeId = activation?.effectiveStackId ?? stack.id;
      if (activation?.fallbackMessage) {
        this.lastError = activation.fallbackMessage;
        this.options.onError?.(activation.fallbackMessage, stack);
      }
      this.viewer.scene.requestRender();
      if (!silent) this.emitChange('ready');
    } catch (error) {
      if (gen !== this.switchGen) return this.getState();
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.options.onError?.(message, stack);
      const recovery = this.getStack(this.options.registry.recoveryId);
      if (recovery && recovery.id !== stack.id && this.isStackAvailable(recovery.id)) {
        try {
          const activation = await this.activate(recovery, gen);
          if (gen !== this.switchGen) return this.getState();
          this.activeId = activation?.effectiveStackId ?? recovery.id;
        } catch (recoveryError) {
          if (gen !== this.switchGen) return this.getState();
          this.lastError = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          this.options.onError?.(this.lastError, recovery);
        }
      }
      if (!silent) this.emitChange('error');
    } finally {
      if (gen === this.switchGen) this.isSwitching = false;
    }
    return this.getState();
  }

  private activate(stack: StackDescriptor, gen: number): Promise<ImageryResolution | undefined> {
    const source = this.sources.get(stack.id)!;
    if (source.imagery) return this.activateGlobeStack(stack, gen);
    if (source.createTileset) return this.activateTileset(source, gen);
    return this.activateBareGlobe(source);
  }

  private async activateBareGlobe(source: MapStackSource): Promise<undefined> {
    this.removeImageryLayer();
    this.showTileset(null);
    this.options.credits.show(source.descriptor.attribution || null);
    this.viewer.scene.globe.show = true;
    return undefined;
  }

  private async activateTileset(source: MapStackSource, gen: number): Promise<undefined> {
    const tileset = await this.cached(this.tilesets, source.descriptor.id, () =>
      source.createTileset!({ signal: this.abort.signal }),
    );
    if (gen !== this.switchGen) return undefined;
    if (!this.ownedTilesets.has(tileset)) {
      tileset.show = false;
      this.viewer.scene.primitives.add(tileset);
      this.ownedTilesets.add(tileset);
    }
    this.removeImageryLayer();
    this.options.credits.show(source.descriptor.attribution || null);
    this.showTileset(tileset);
    // A photogrammetry tileset replaces the globe while it is active.
    this.viewer.scene.globe.show = false;
    return undefined;
  }

  private showTileset(active: TilesetLike | null): void {
    for (const tileset of this.ownedTilesets) tileset.show = tileset === active;
  }

  private async activateGlobeStack(stack: StackDescriptor, gen: number): Promise<ImageryResolution> {
    const resolution = await this.getImageryProvider(stack);
    if (gen !== this.switchGen) return resolution;
    // Keep the live layer (and its loaded tiles) when the resolved provider is unchanged;
    // rebuilding it exposes the bare globe while imagery loads again.
    if (!this.imageryLayer || this.activeImageryProvider !== resolution.provider) {
      this.removeImageryLayer();
      this.imageryLayer = this.options.createImageryLayer(resolution.provider);
      this.activeImageryProvider = resolution.provider;
      this.viewer.imageryLayers.add(this.imageryLayer, 0);
    }
    const source = this.sources.get(resolution.effectiveStackId);
    this.options.credits.show(source?.descriptor.attribution || null);
    // A repeated request still owns a new switch generation: rebind the failure
    // listener so fallback remains live without accumulating listeners.
    this.removeImageryErrorListener?.();
    this.removeImageryErrorListener = null;
    this.watchProvider(resolution, gen);
    this.showTileset(null);
    this.viewer.scene.globe.show = true;
    this.activeId = resolution.effectiveStackId;
    return resolution;
  }

  private cached<T>(cache: Map<string, Promise<T>>, id: string, create: () => Promise<T> | T): Promise<T> {
    const hit = cache.get(id);
    if (hit) return hit;
    const promise: Promise<T> = Promise.resolve()
      .then(() => {
        this.abort.signal.throwIfAborted();
        return create();
      })
      .catch((error: unknown) => {
        if (cache.get(id) === promise) cache.delete(id);
        throw error;
      });
    cache.set(id, promise);
    return promise;
  }

  private getImageryProvider(stack: StackDescriptor, visited: Set<string> = new Set()): Promise<ImageryResolution> {
    if (visited.has(stack.id)) return Promise.reject(new Error('Map source fallback cycle'));
    return this.cached(this.imageryProviders, stack.id, async () => {
      const source = this.sources.get(stack.id)!;
      try {
        const provider = await source.imagery!({ signal: this.abort.signal });
        if (this.destroyed) this.dispose(provider);
        return { provider, effectiveStackId: stack.id, fallbackMessage: null };
      } catch (error) {
        const fallback = source.constructionFallback;
        if (this.destroyed || !fallback || !this.isStackAvailable(fallback.id)) throw error;
        const next = new Set(visited).add(stack.id);
        const resolution = await this.getImageryProvider(this.getStack(fallback.id)!, next);
        // Carry the reason. This used to report only "X is unavailable; showing Natural
        // Earth II", which tells an operator that something failed and nothing about
        // what — and it cost a long session to work out that two different online
        // basemaps were both falling back, because the message was identical and
        // content-free either way. Whatever the provider threw (a 403, a CORS refusal, a
        // DNS failure, a malformed service document) is the only part worth reading.
        return { ...resolution, fallbackMessage: `${fallback.message} — ${describeCause(error)}` };
      }
    });
  }

  private watchProvider(resolution: ImageryResolution, gen: number): void {
    const fallback = this.sources.get(resolution.effectiveStackId)?.tileFailureFallback;
    const errorEvent = resolution.provider.errorEvent;
    if (!fallback || !errorEvent) return;
    let failures = 0;
    let pending = false;
    this.removeImageryErrorListener = errorEvent.addEventListener((error) => {
      if (gen !== this.switchGen || this.activeImageryProvider !== resolution.provider) return;
      const retryCount = Number(error?.timesRetried);
      failures =
        Number.isInteger(retryCount) && retryCount >= 0 ? Math.max(failures + 1, retryCount + 1) : failures + 1;
      if (failures < fallback.threshold || pending) return;
      pending = true;
      this.options.onError?.(fallback.message, this.getStack(resolution.effectiveStackId)!);
      const expectedGen = this.switchGen + 1;
      void this.setStack(fallback.id, { silent: true })
        .then((state) => {
          if (!this.destroyed && this.switchGen === expectedGen && state.activeId === fallback.id) {
            this.lastError = fallback.message;
            this.emitChange('error');
          }
        })
        .finally(() => {
          pending = false;
        });
    });
  }

  private removeImageryLayer(): void {
    this.removeImageryErrorListener?.();
    this.removeImageryErrorListener = null;
    if (this.imageryLayer) this.viewer.imageryLayers.remove(this.imageryLayer, true);
    this.imageryLayer = null;
    this.activeImageryProvider = null;
  }

  private dispose(value: { destroy?(): void; isDestroyed?(): boolean } | null | undefined): void {
    if (!value || this.disposedValues.has(value)) return;
    this.disposedValues.add(value);
    if (typeof value.destroy === 'function' && !value.isDestroyed?.()) value.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.switchGen++;
    this.abort.abort();
    this.isSwitching = false;
    this.removeImageryLayer();
    this.options.credits.destroy();
    for (const promise of this.imageryProviders.values())
      void promise.then(
        (value) => this.dispose(value.provider),
        () => undefined,
      );
    for (const tileset of this.ownedTilesets) {
      this.viewer.scene.primitives.remove(tileset);
      this.dispose(tileset);
    }
    for (const promise of this.tilesets.values())
      void promise.then(
        (value) => this.dispose(value),
        () => undefined,
      );
    this.imageryProviders.clear();
    this.tilesets.clear();
    this.ownedTilesets.clear();
  }
}

// ── registry ──────────────────────────────────────────────────────────────────
export const NATURAL_EARTH_STACK_ID = 'natural-earth';
export const ESRI_STACK_ID = 'esri-world-imagery';
export const OSM_STACK_ID = 'osm-raster';
export const ION_BING_STACK_ID = 'cesium-ion-bing';
export const GOOGLE_3D_STACK_ID = 'google-3d';
export const NONE_STACK_ID = 'none';

export interface StackRegistryOptions {
  ionToken?: string;
  google?: Google3DOptions;
}

export type StackRegistryModule = ImageryFactoryModule & Pick<CesiumLike, 'createGooglePhotorealistic3DTileset'>;

/** Default registry: Natural Earth II is the default AND the recovery stack; everything else is opt-in. */
export function buildCesiumStackRegistry(
  cesium: StackRegistryModule,
  opts: StackRegistryOptions = {},
): MapStackRegistry {
  const ionToken = (opts.ionToken ?? '').trim();
  const naturalEarthFallback = (message: string) => ({ id: NATURAL_EARTH_STACK_ID, message });
  const google = google3dAvailability(opts.google);
  const sources: MapStackSource[] = [
    {
      descriptor: {
        id: NATURAL_EARTH_STACK_ID,
        label: 'Natural Earth II',
        kind: 'imagery',
        attribution: NATURAL_EARTH_ATTRIBUTION,
        review: 'approved',
        offlineCapable: true,
      },
      available: true,
      imagery: () => createNaturalEarthImagery(cesium),
    },
    {
      descriptor: {
        id: ESRI_STACK_ID,
        label: 'Esri World Imagery',
        kind: 'imagery',
        attribution: ESRI_ATTRIBUTION,
        review: 'conditional',
        offlineCapable: false,
      },
      available: true,
      imagery: () => createEsriWorldImagery(cesium),
      constructionFallback: naturalEarthFallback('Esri World Imagery is unavailable; showing Natural Earth II'),
      tileFailureFallback: {
        ...naturalEarthFallback('Esri World Imagery tile requests failed; showing Natural Earth II'),
        threshold: 2,
      },
    },
    {
      descriptor: {
        id: OSM_STACK_ID,
        label: 'OpenStreetMap raster',
        kind: 'imagery',
        attribution: OSM_ATTRIBUTION,
        review: 'conditional',
        offlineCapable: false,
      },
      available: true,
      imagery: () => createOsmImagery(cesium),
      tileFailureFallback: {
        ...naturalEarthFallback('OpenStreetMap tile requests failed; showing Natural Earth II'),
        threshold: 2,
      },
    },
    {
      descriptor: {
        id: ION_BING_STACK_ID,
        label: 'Bing Aerial with labels (Cesium ion)',
        kind: 'imagery',
        attribution: 'Imagery via Cesium ion',
        review: 'conditional',
        offlineCapable: false,
        requires: 'ion-token',
      },
      available: Boolean(ionToken),
      ...(ionToken ? {} : { unavailableReason: 'Needs your own Cesium ion token (Settings → Map providers)' }),
      imagery: () => createIonImagery(cesium, cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS, ionToken),
      constructionFallback: naturalEarthFallback('Cesium ion imagery is unavailable; showing Natural Earth II'),
    },
    {
      descriptor: {
        id: GOOGLE_3D_STACK_ID,
        label: 'Google Photorealistic 3D',
        kind: 'tileset',
        attribution: GOOGLE_3D_ATTRIBUTION,
        review: 'conditional',
        offlineCapable: false,
        requires: 'google-key',
      },
      available: google.available,
      ...(google.reason ? { unavailableReason: google.reason } : {}),
      ...(opts.google
        ? { createTileset: (ctx: { signal: AbortSignal }) => createGoogle3DTileset(cesium, opts.google!, ctx) }
        : {}),
    },
    {
      descriptor: {
        id: NONE_STACK_ID,
        label: 'No imagery',
        kind: 'none',
        attribution: '',
        review: 'approved',
        offlineCapable: true,
      },
      available: true,
    },
  ];
  return { defaultId: NATURAL_EARTH_STACK_ID, recoveryId: NATURAL_EARTH_STACK_ID, sources };
}

/**
 * Map a contract `BasemapDescriptor` to a stack id, registering user-supplied
 * XYZ sources on the fly. Vector styles and PMTiles are 2D-only: the 3D adapter
 * reports them as unsupported and stays on its current stack.
 */
export function stackIdForBasemap(
  controller: MapStackController,
  cesium: ImageryFactoryModule,
  basemap: BasemapDescriptor,
): { stackId: string } | { unsupported: string } {
  switch (basemap.kind) {
    case 'cesium-natural-earth':
      return { stackId: NATURAL_EARTH_STACK_ID };
    case 'esri-world-imagery':
      return { stackId: ESRI_STACK_ID };
    case 'none':
      return { stackId: NONE_STACK_ID };
    case 'cesium-ion': {
      if (basemap.assetId === 3) return { stackId: ION_BING_STACK_ID };
      return { unsupported: `Cesium ion asset ${basemap.assetId} is not a registered imagery stack` };
    }
    case 'raster-xyz': {
      const id = `raster-xyz:${basemap.id}`;
      if (!controller.getStack(id)) {
        const isOsm = /tile\.openstreetmap\.org/.test(basemap.url);
        controller.registerSource({
          descriptor: {
            id,
            label: basemap.id,
            kind: 'imagery',
            attribution: basemap.attribution,
            review: isOsm ? 'conditional' : 'approved',
            offlineCapable: !/^https?:/.test(basemap.url),
          },
          available: true,
          imagery: () =>
            createXyzImagery(cesium, {
              url: basemap.url,
              attribution: basemap.attribution,
              maxZoom: basemap.maxZoom,
              ...(basemap.tileSize !== undefined ? { tileSize: basemap.tileSize } : {}),
            }),
          tileFailureFallback: {
            id: NATURAL_EARTH_STACK_ID,
            threshold: 3,
            message: `${basemap.id} tile requests failed; showing Natural Earth II`,
          },
        });
      }
      return { stackId: id };
    }
    case 'vector-style':
      return { unsupported: 'Vector styles render in the 2D map only' };
    case 'pmtiles':
      return { unsupported: 'PMTiles basemaps render in the 2D map only' };
  }
}
