import type * as MapLibre from 'maplibre-gl';
import type * as Pmtiles from 'pmtiles';
import type { ControlLike, GeoJSONSourceLike, LngLatBoundsLike, LngLatLike, MapEventMap, MapLibreLike, MapLike, MapOptionsLike, PmtilesLike, PointLike, QueriedFeatureLike, StyleImageLike } from './maplibre-like.js';
import type { LayerSpec, MapStyle, SourceSpec } from './styles/spec.js';

/**
 * Adapts the real `maplibre-gl` and `pmtiles` modules to the narrow interfaces
 * the renderer consumes. This is the ONE file typed against the libraries' own
 * declarations (declaration shims from tools/dev/type-shims when the packages
 * are not installed), so the typecheck verifies that every member the adapter
 * relies on exists with a compatible signature.
 */
export type MapLibreModule = typeof MapLibre;
export type PmtilesModule = typeof Pmtiles;

/**
 * Our style/layer/source types are a typed, test-validated subset of the style
 * specification. The library's types spell expressions as an exhaustive tuple
 * union that a generated object cannot be proven to inhabit, so these are the
 * deliberate widening points (runtime shape is identical).
 */
export function toStyleSpecification(style: MapStyle): MapLibre.StyleSpecification {
  return style as unknown as MapLibre.StyleSpecification;
}
function toLayerSpecification(layer: LayerSpec): MapLibre.LayerSpecification {
  return layer as unknown as MapLibre.LayerSpecification;
}
function toSourceSpecification(source: SourceSpec): MapLibre.SourceSpecification {
  return source as unknown as MapLibre.SourceSpecification;
}

/** Composition wrapper: every method delegates with the library's own signature. */
class AdaptedMap implements MapLike {
  readonly inner: MapLibre.Map;
  constructor(M: MapLibreModule, options: MapOptionsLike) {
    const { style, ...rest } = options;
    this.inner = new M.Map({ ...rest, style: typeof style === 'string' ? style : toStyleSpecification(style) });
  }
  on<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): void {
    // Events are dispatched by name; the payload for `type` is what the library documents for it.
    this.inner.on(type, (ev: unknown) => listener(ev as MapEventMap[K]));
  }
  off<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): void {
    this.inner.off(type, listener as (ev: unknown) => void);
  }
  once<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): void {
    this.inner.once(type, (ev: unknown) => listener(ev as MapEventMap[K]));
  }
  addSource(id: string, source: SourceSpec): void { this.inner.addSource(id, toSourceSpecification(source)); }
  getSource(id: string): GeoJSONSourceLike | undefined { return this.inner.getSource<MapLibre.GeoJSONSource>(id); }
  removeSource(id: string): void { this.inner.removeSource(id); }
  addLayer(layer: LayerSpec, beforeId?: string): void { this.inner.addLayer(toLayerSpecification(layer), beforeId); }
  removeLayer(id: string): void { this.inner.removeLayer(id); }
  getLayer(id: string): { id: string } | undefined { return this.inner.getLayer(id); }
  addImage(id: string, image: StyleImageLike, options?: { pixelRatio?: number; sdf?: boolean }): void { this.inner.addImage(id, image, options); }
  hasImage(id: string): boolean { return this.inner.hasImage(id); }
  removeImage(id: string): void { this.inner.removeImage(id); }
  queryRenderedFeatures(point: PointLike, options?: { layers?: string[] }): QueriedFeatureLike[] { return this.inner.queryRenderedFeatures([point.x, point.y], options); }
  setStyle(style: MapStyle | string): void { this.inner.setStyle(typeof style === 'string' ? style : toStyleSpecification(style)); }
  isStyleLoaded(): boolean { return this.inner.isStyleLoaded(); }
  getCenter(): LngLatLike { return this.inner.getCenter(); }
  getZoom(): number { return this.inner.getZoom(); }
  getBearing(): number { return this.inner.getBearing(); }
  getPitch(): number { return this.inner.getPitch(); }
  getBounds(): LngLatBoundsLike { return this.inner.getBounds(); }
  jumpTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void { this.inner.jumpTo(options); }
  easeTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number }): void { this.inner.easeTo(options); }
  flyTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number; essential?: boolean }): void { this.inner.flyTo(options); }
  fitBounds(bounds: [number, number, number, number], options?: { padding?: number; duration?: number; maxZoom?: number }): void { this.inner.fitBounds(bounds, options); }
  stop(): void { this.inner.stop(); }
  resize(): void { this.inner.resize(); }
  redraw(): void { this.inner.redraw(); }
  triggerRepaint(): void { this.inner.triggerRepaint(); }
  getCanvas(): HTMLCanvasElement { return this.inner.getCanvas(); }
  addControl(control: ControlLike, position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'): void { this.inner.addControl(asControl(control), position); }
  removeControl(control: ControlLike): void { this.inner.removeControl(asControl(control)); }
  remove(): void { this.inner.remove(); }
}

/** Controls we add come from the same module (`new M.AttributionControl`), so they are IControls. */
function asControl(control: ControlLike): MapLibre.IControl {
  return control as MapLibre.IControl;
}

/**
 * maplibre-gl and pmtiles ship ESM whose members live on the *default* export, so
 * `import('maplibre-gl')` yields a namespace where `AttributionControl` is undefined and
 * only `default.AttributionControl` exists. Reading the namespace directly type-checked
 * against the declaration shim written here and broke against the real package — the 2D
 * renderer would have failed at `new M.AttributionControl()` the first time a map
 * mounted in Electron. Unwrap the default when there is one.
 */
function interop<T>(module: T): T {
  const d = (module as { default?: T }).default;
  return d ?? module;
}

export function adaptMapLibreModule(module: MapLibreModule): MapLibreLike {
  const M = interop(module);
  return {
    Map: class extends AdaptedMap { constructor(options: MapOptionsLike) { super(M, options); } },
    AttributionControl: M.AttributionControl,
    addProtocol: (name, loader) => M.addProtocol(name, loader),
    removeProtocol: (name) => M.removeProtocol(name),
  };
}

export function adaptPmtilesModule(module: PmtilesModule): PmtilesLike {
  const P = interop(module);
  return { Protocol: P.Protocol };
}

export async function loadMapLibre(): Promise<{ maplibre: MapLibreLike; pmtiles: PmtilesLike }> {
  const [m, p]: [MapLibreModule, PmtilesModule] = await Promise.all([import('maplibre-gl'), import('pmtiles')]);
  return { maplibre: adaptMapLibreModule(m), pmtiles: adaptPmtilesModule(p) };
}
