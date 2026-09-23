import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type {
  AttributionEntry,
  BasemapDescriptor,
  FeatureUpdate,
  LensDefinition,
  ReferenceData,
  ReferenceOptions,
  RenderMode,
  RendererEvents,
  TerrainDescriptor,
  ViewState,
} from '@worldview/render-core';

/**
 * The minimal renderer-host surface the shell codes against. The real
 * `RendererHost` (packages/render-core/src/renderer-host.ts, owned by the render
 * workstream) wraps the Cesium and MapLibre adapters, switches modes and suspends the
 * hidden renderer; it is expected to satisfy this interface structurally. The demo
 * build ships a plain-canvas host (`demo/canvas-host.ts`) so the shell runs without
 * Cesium or MapLibre installed.
 */
/**
 * What a *host* emits: every renderer event, plus the switch between renderers — which no
 * single renderer can report, because it is the thing that replaces one with the other.
 *
 * It is a separate map rather than an addition to RendererEvents because a renderer has
 * exactly one mode and cannot change it. Before this existed the desktop host had no way
 * to announce a completed switch at all, so the shell resorted to reading activeMode()
 * synchronously after setMode() and got the mode being left.
 */
export interface RendererHostEvents extends RendererEvents {
  modeChanged: { mode: '2D' | '3D'; requested: RenderMode };
}

export interface RendererHostLike {
  mount(container: HTMLElement): Promise<void> | void;
  unmount(): void;
  setMode(mode: RenderMode): void;
  /** The mode currently rendering (AUTO resolves to one of the two). */
  activeMode(): '2D' | '3D';
  /** Whether a mode can be rendered at all (absent = both). The shell hides toggles for unsupported modes rather than showing dead controls. */
  supportsMode?(mode: '2D' | '3D'): boolean;
  /**
   * Features the *currently active* renderer says it can carry. The shell runs the
   * presentation pass itself, so without this it has no way to respect a limit the
   * renderer already knows — and the two adapters do not agree on it (MapLibre feeds
   * GeoJSON sources, Cesium builds one primitive per feature).
   */
  maxFeatures?(): number;
  getView(): ViewState;
  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts?: { durationMs?: number },
  ): Promise<void> | void;
  select(featureId: string | null): void;
  setLens(lens: LensDefinition): void;
  setFeatures?(update: FeatureUpdate): void;
  /**
   * Show a basemap / terrain. These were implemented on `DesktopRendererHost`, covered by
   * its tests, and left off this interface — so no shell code could call them and none
   * did. The visible effect was that changing the basemap in Settings moved the credit
   * line (which the shell computes from the setting) and left the imagery exactly as it
   * was, which reads as a failing provider and is not one. The terrain picker did nothing
   * whatsoever.
   */
  setBasemap?(basemap: BasemapDescriptor, forMode?: '2D' | '3D'): Promise<void> | void;
  setTerrain?(terrain: TerrainDescriptor): Promise<void> | void;
  /** Borders and names (render-core reference.ts); replayed into whichever renderer is active. */
  setReference?(data: ReferenceData | null, options: ReferenceOptions): void;
  setAttribution?(entries: AttributionEntry[]): void;
  on<K extends keyof RendererHostEvents>(event: K, listener: (payload: RendererHostEvents[K]) => void): () => void;
}
