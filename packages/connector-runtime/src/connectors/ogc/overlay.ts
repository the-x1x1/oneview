import type { GeoBounds } from '@worldview/world-model';
import type { WorldProvider } from '@worldview/provider-sdk';

/**
 * SHIM — the raster overlay contract, as phase `ogc` needs it, until the integrator lands
 * the ADR-008 amendment requested in docs/roadmap/phases/ogc.md ("Overlay layer contract").
 * When that amendment lands, `RasterOverlay` moves to the frozen contract (render-core or
 * provider-sdk, as the amendment decides), this file is deleted, and the WMS and WMTS
 * providers publish through the new capability instead of `overlay()`. Nothing outside
 * packages/connector-runtime/src/connectors/ogc imports it; no renderer draws it yet.
 *
 * Until then the `wms` and `wmts` connectors produce zero observations and expose the
 * descriptor they built from the service's capabilities through `overlay()`.
 */
export interface RasterOverlay {
  /** The definition's id. */
  id: string;
  kind: 'wms' | 'wmts' | 'xyz';
  /**
   * The tile URL. WMS: `{bbox}`, `{width}`, `{height}` and `{crs}` for the renderer to fill
   * (the bounding box in `crs`, axes in `bboxAxisOrder`). WMTS and XYZ: `{z}`, `{x}`, `{y}`
   * (row from the top), or `{tileMatrix}` in place of `{z}` when the service's matrix
   * identifiers are not the zoom numbers (see `zToTileMatrix`).
   */
  urlTemplate: string;
  /** The definition's attribution text: shown in the map corner as for a basemap. */
  attribution: string;
  minZoom?: number;
  maxZoom?: number;
  opacity?: number;
  /** Where the layer has data (WGS 84 degrees); the renderer need not request tiles outside. */
  bounds?: GeoBounds;

  // What a renderer needs beyond the brief's minimum to fill the template correctly.
  /** Pixels per tile edge (256 unless the service says otherwise). */
  tileSize: number;
  /** WMS: the CRS to fill into `{crs}` and to express `{bbox}` in. */
  crs?: string;
  /** WMS: `yx` when the bounding box is latitude first (WMS 1.3.0 with EPSG:4326). */
  bboxAxisOrder?: 'xy' | 'yx';
  /** WMTS: the matrix identifier for each zoom level (index = z), `null` where the set has none. */
  zToTileMatrix?: Array<string | null>;
  /** Hosts the template reaches — always the definition's own endpoint host. */
  hosts: string[];
  layer: string;
  style?: string;
  format: string;
  title?: string;
  /** A legend image on the same host, when the service lists one for the chosen style. */
  legendUrl?: string;
  /** A time dimension: the value in the template, the service's default and extent. */
  time?: { value?: string; default?: string; extent?: string };
  /** The service's own attribution line, for reference beside the definition's. */
  serviceAttribution?: string;
}

/** A provider that publishes a raster overlay (the shim's stand-in for the amendment's capability). */
export interface OverlayProvider {
  /** The descriptor from the last successful capabilities read; undefined before the first. */
  overlay(): RasterOverlay | undefined;
}

export function isOverlayProvider(p: WorldProvider): p is WorldProvider & OverlayProvider {
  return typeof (p as Partial<OverlayProvider>).overlay === 'function';
}
