import type { GlyphContext } from '@worldview/render-core';
import type { GeoJsonFeatureCollection } from '../geojson.js';
import type {
  ControlLike,
  GeoJSONSourceLike,
  LngLatBoundsLike,
  LngLatLike,
  MapEventMap,
  MapLibreLike,
  MapLike,
  MapOptionsLike,
  PmtilesLike,
  PointLike,
  ProtocolLoader,
  QueriedFeatureLike,
  StyleImageLike,
} from '../maplibre-like.js';
import type { LayerSpec, MapStyle, SourceSpec } from '../styles/spec.js';
import type { ImageCanvasFactory } from '../images.js';

/**
 * A fake MapLibre module for Node tests: records sources, layers, images,
 * camera state and controls; `fire()` raises map events; `queryResults` scripts
 * what `queryRenderedFeatures` returns. `load` fires on the next microtask after
 * construction, `style.load` synchronously inside `setStyle`.
 */
export class FakeGeoJSONSource implements GeoJSONSourceLike {
  data: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
  setDataCalls = 0;
  constructor(readonly spec: SourceSpec) {}
  setData(data: GeoJsonFeatureCollection): void {
    this.data = data;
    this.setDataCalls++;
  }
}

export class FakeMap implements MapLike {
  readonly sources = new Map<string, FakeGeoJSONSource>();
  readonly layers: LayerSpec[] = [];
  readonly images = new Map<string, StyleImageLike>();
  readonly controls: ControlLike[] = [];
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  style: MapStyle | string;
  center: LngLatLike;
  zoom: number;
  bearing: number;
  pitch: number;
  stops = 0;
  repaints = 0;
  redraws = 0;
  removed = false;
  queryResults: QueriedFeatureLike[] = [];
  readonly queries: Array<{ point: PointLike; layers: string[] | undefined }> = [];
  readonly canvas = {
    width: 800,
    height: 600,
    toBlob: (cb: (b: null) => void) => cb(null),
  } as unknown as HTMLCanvasElement;
  constructor(readonly options: MapOptionsLike) {
    this.style = options.style;
    this.center = { lng: options.center?.[0] ?? 0, lat: options.center?.[1] ?? 0 };
    this.zoom = options.zoom ?? 0;
    this.bearing = options.bearing ?? 0;
    this.pitch = options.pitch ?? 0;
    queueMicrotask(() => {
      this.fire('style.load', {});
      this.fire('load', {});
    });
  }
  fire<K extends keyof MapEventMap>(type: K, ev: MapEventMap[K]): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(ev);
  }
  on<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as (ev: unknown) => void);
  }
  off<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): void {
    this.listeners.get(type)?.delete(listener as (ev: unknown) => void);
  }
  once<K extends keyof MapEventMap>(type: K, listener: (ev: MapEventMap[K]) => void): void {
    const wrapped = (ev: MapEventMap[K]) => {
      this.off(type, wrapped);
      listener(ev);
    };
    this.on(type, wrapped);
  }
  addSource(id: string, source: SourceSpec): void {
    if (this.sources.has(id)) throw new Error(`source ${id} exists`);
    this.sources.set(id, new FakeGeoJSONSource(source));
  }
  getSource(id: string): FakeGeoJSONSource | undefined {
    return this.sources.get(id);
  }
  removeSource(id: string): void {
    this.sources.delete(id);
  }
  addLayer(layer: LayerSpec, beforeId?: string): void {
    if (this.layers.some((l) => l.id === layer.id)) throw new Error(`layer ${layer.id} exists`);
    if (
      layer.type !== 'background' &&
      !this.sources.has(layer.source) &&
      !(typeof this.style === 'object' && this.style.sources[layer.source])
    )
      throw new Error(`layer ${layer.id}: unknown source ${layer.source}`);
    const i = beforeId ? this.layers.findIndex((l) => l.id === beforeId) : -1;
    if (i >= 0) this.layers.splice(i, 0, layer);
    else this.layers.push(layer);
  }
  removeLayer(id: string): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i >= 0) this.layers.splice(i, 1);
  }
  getLayer(id: string): { id: string } | undefined {
    return this.layers.find((l) => l.id === id);
  }
  addImage(id: string, image: StyleImageLike): void {
    if (this.images.has(id)) throw new Error(`image ${id} exists`);
    this.images.set(id, image);
  }
  hasImage(id: string): boolean {
    return this.images.has(id);
  }
  removeImage(id: string): void {
    this.images.delete(id);
  }
  queryRenderedFeatures(point: PointLike, options?: { layers?: string[] }): QueriedFeatureLike[] {
    this.queries.push({ point, layers: options?.layers });
    return this.queryResults;
  }
  setStyle(style: MapStyle | string): void {
    this.style = style;
    this.sources.clear();
    this.layers.length = 0;
    this.images.clear();
    this.fire('style.load', {});
  }
  isStyleLoaded(): boolean {
    return true;
  }
  getCenter(): LngLatLike {
    return this.center;
  }
  getZoom(): number {
    return this.zoom;
  }
  getBearing(): number {
    return this.bearing;
  }
  getPitch(): number {
    return this.pitch;
  }
  getBounds(): LngLatBoundsLike {
    const span = 360 / Math.pow(2, this.zoom);
    const c = this.center;
    return {
      getWest: () => c.lng - span / 2,
      getEast: () => c.lng + span / 2,
      getSouth: () => Math.max(-85, c.lat - span / 4),
      getNorth: () => Math.min(85, c.lat + span / 4),
    };
  }
  private applyCamera(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
    if (o.center) this.center = { lng: o.center[0], lat: o.center[1] };
    if (o.zoom !== undefined) this.zoom = o.zoom;
    if (o.bearing !== undefined) this.bearing = o.bearing;
    if (o.pitch !== undefined) this.pitch = o.pitch;
    this.fire('move', {});
    this.fire('moveend', {});
  }
  jumpTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
    this.applyCamera(o);
  }
  easeTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number }): void {
    this.applyCamera(o);
  }
  flyTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number }): void {
    this.applyCamera(o);
  }
  fitBounds(b: [number, number, number, number], options?: { maxZoom?: number }): void {
    const span = Math.max(b[2] - b[0], (b[3] - b[1]) * 2);
    this.applyCamera({
      center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
      zoom: Math.min(options?.maxZoom ?? 22, Math.log2(360 / span)),
    });
  }
  stop(): void {
    this.stops++;
  }
  resize(): void {
    /* noop */
  }
  redraw(): void {
    this.redraws++;
  }
  triggerRepaint(): void {
    this.repaints++;
  }
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
  addControl(control: ControlLike): void {
    this.controls.push(control);
  }
  removeControl(control: ControlLike): void {
    const i = this.controls.indexOf(control);
    if (i >= 0) this.controls.splice(i, 1);
  }
  remove(): void {
    this.removed = true;
    this.listeners.clear();
  }
}

export class FakeAttributionControl implements ControlLike {
  constructor(readonly options?: { compact?: boolean; customAttribution?: string | string[] }) {}
  onAdd(): HTMLElement {
    return {} as HTMLElement;
  }
  onRemove(): void {
    /* noop */
  }
}

export interface FakeMapLibre extends MapLibreLike {
  maps: FakeMap[];
  protocols: Map<string, ProtocolLoader>;
}

export function createFakeMapLibre(): FakeMapLibre {
  const maps: FakeMap[] = [];
  const protocols = new Map<string, ProtocolLoader>();
  return {
    maps,
    protocols,
    Map: class extends FakeMap {
      constructor(options: MapOptionsLike) {
        super(options);
        maps.push(this);
      }
    },
    AttributionControl: FakeAttributionControl,
    addProtocol: (name, loader) => {
      protocols.set(name, loader);
    },
    removeProtocol: (name) => {
      protocols.delete(name);
    },
  };
}

export function createFakePmtiles(): PmtilesLike & { instances: number } {
  const mod = {
    instances: 0,
    Protocol: class {
      tile: ProtocolLoader;
      constructor() {
        mod.instances++;
        this.tile = async (req) => ({ data: new ArrayBuffer(0), cacheControl: null, expires: null, url: req.url });
      }
    },
  };
  return mod;
}

/** Canvas factory producing deterministic RGBA buffers (glyph drawing is a no-op in Node). */
export function fakeImageCanvasFactory(): ImageCanvasFactory {
  return (width, height) => {
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (prop === 'getImageData')
          return (x: number, y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          });
        return typeof prop === 'string' && /^(fillStyle|strokeStyle|lineWidth|lineJoin|lineCap|globalAlpha)$/.test(prop)
          ? ''
          : () => undefined;
      },
      set: () => true,
    });
    return {
      width,
      height,
      getContext: () =>
        ctx as unknown as GlyphContext & {
          getImageData(
            x: number,
            y: number,
            w: number,
            h: number,
          ): { width: number; height: number; data: Uint8ClampedArray };
        },
    };
  };
}
