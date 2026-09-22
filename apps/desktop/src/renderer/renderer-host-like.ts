import type { GeoBounds, GeoPosition } from '@worldview/world-model';
import type {
  AttributionEntry,
  FeatureUpdate,
  LensDefinition,
  RenderMode,
  RendererEvents,
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
export interface RendererHostLike {
  mount(container: HTMLElement): Promise<void> | void;
  unmount(): void;
  setMode(mode: RenderMode): void;
  /** The mode currently rendering (AUTO resolves to one of the two). */
  activeMode(): '2D' | '3D';
  /** Whether a mode can be rendered at all (absent = both). The shell hides toggles for unsupported modes rather than showing dead controls. */
  supportsMode?(mode: '2D' | '3D'): boolean;
  getView(): ViewState;
  flyTo(
    target: { position: GeoPosition; altitudeM?: number; zoom?: number; bounds?: GeoBounds },
    opts?: { durationMs?: number },
  ): Promise<void> | void;
  select(featureId: string | null): void;
  setLens(lens: LensDefinition): void;
  setFeatures?(update: FeatureUpdate): void;
  setAttribution?(entries: AttributionEntry[]): void;
  on<K extends keyof RendererEvents>(event: K, listener: (payload: RendererEvents[K]) => void): () => void;
}
