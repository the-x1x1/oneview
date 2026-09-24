import { s, type Schema } from './schema.js';
import type { GeoBounds } from './geo.js';

/**
 * A raster overlay (ADR-008 amendment, 2026-09-23): a tiled picture a provider publishes
 * for the renderers to draw between the basemap and the world's objects — a WMS layer, a
 * WMTS layer or an XYZ tile set. It is not an observation: it has no position, no history
 * and no identity; it is a way of seeing, with an attribution and a host, that comes and
 * goes with the provider that publishes it.
 *
 * Every kind names the one host its tiles come from, which must be among the provider's
 * `allowedHosts` — the host refuses the rest — and https, like everything a definition
 * may name. The renderers fetch tiles themselves (the CSP allows https images), so the
 * descriptor is all a renderer needs, and `overlayTileTemplate` turns any kind into the
 * `{z}/{x}/{y}` (or `{bbox-epsg-3857}`) template a 2D tile source takes.
 */
interface OverlayBase {
  /** Unique across providers: `<providerId>:<layer>` by convention. */
  id: string;
  providerId: string;
  name: string;
  attribution: string;
  /** 0–1; default 1. */
  opacity?: number;
  minZoom?: number;
  maxZoom?: number;
  /** Where the layer has data; a renderer may skip tiles outside it. */
  bounds?: GeoBounds;
}

export interface XyzOverlay extends OverlayBase {
  kind: 'xyz';
  /** `{z}`, `{x}`, `{y}` and optionally `{s}` (a subdomain) or `{-y}` (TMS rows). */
  url: string;
  subdomains?: string[];
  tileSize?: number;
}

export interface WmsOverlay extends OverlayBase {
  kind: 'wms';
  /** The GetMap endpoint without query parameters. */
  url: string;
  /** Comma-separated layer names, as the capabilities list them. */
  layers: string;
  styles?: string;
  format?: 'image/png' | 'image/jpeg' | 'image/webp';
  version?: '1.1.1' | '1.3.0';
  transparent?: boolean;
  /** Extra GetMap parameters (a `TIME`, a vendor option); values are sent as given. */
  parameters?: Record<string, string>;
  tileSize?: number;
}

export interface WmtsOverlay extends OverlayBase {
  kind: 'wmts';
  /**
   * A RESTful resource template with `{TileMatrix}`, `{TileRow}`, `{TileCol}` (and optionally
   * `{Style}`, `{TileMatrixSet}`), or a KVP endpoint (no placeholders: the parameters are added).
   */
  url: string;
  layer: string;
  style: string;
  format: string;
  /** Must be a Web Mercator (EPSG:3857 / GoogleMapsCompatible) matrix set for the 2D renderer. */
  tileMatrixSet: string;
  /**
   * Whether the matrix set is Web Mercator, when the provider knows from the capabilities
   * (its CRS, corner and scales) rather than the name: a set named `default028mm` may be, and
   * one named `EPSG:3857-ish` may not. Absent: told by the name (`isWebMercatorMatrixSet`).
   */
  webMercator?: boolean;
  /**
   * The matrix identifier for each zoom level when it is not the zoom number itself. A label
   * must be its zoom number exactly, or one prefix followed by it (`EPSG:3857:5`); a padded
   * label (`05`) cannot be written into a `{z}` template and the set is reported, not drawn.
   */
  tileMatrixLabels?: string[];
  tileSize?: number;
}

export type RasterOverlay = XyzOverlay | WmsOverlay | WmtsOverlay;

export const MAX_OVERLAYS_PER_PROVIDER = 32;
const OVERLAY_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MAX_URL = 2048;

const httpsUrl = s.refine(s.string({ min: 12, max: MAX_URL }), (v) => {
  let u: URL;
  try {
    u = new URL(v.replace(/\{[^}]*\}/g, 'x'));
  } catch {
    return 'is not a URL';
  }
  if (u.protocol !== 'https:') return 'must be https';
  if (u.username || u.password) return 'must not carry credentials';
  return undefined;
});
const boundsSchema: Schema<GeoBounds> = s.refine(
  s.object({
    west: s.number({ min: -180, max: 180 }),
    south: s.number({ min: -90, max: 90 }),
    east: s.number({ min: -180, max: 180 }),
    north: s.number({ min: -90, max: 90 }),
  }),
  (b) => (b.south <= b.north ? undefined : 'south must be <= north'),
);
const base = {
  id: s.string({ min: 1, max: 128, pattern: OVERLAY_ID }),
  providerId: s.string({ min: 1, max: 128 }),
  name: s.string({ min: 1, max: 200 }),
  attribution: s.string({ min: 1, max: 500 }),
  opacity: s.optional(s.number({ min: 0, max: 1 })),
  minZoom: s.optional(s.number({ min: 0, max: 30, integer: true })),
  maxZoom: s.optional(s.number({ min: 0, max: 30, integer: true })),
  bounds: s.optional(boundsSchema),
};
const tileSize = s.optional(s.enum([256, 512] as const));
const param = s.string({ max: 512 });

export const rasterOverlaySchema: Schema<RasterOverlay> = s.refine(
  s.union([
    s.object({
      ...base,
      kind: s.literal('xyz'),
      url: httpsUrl,
      subdomains: s.optional(s.array(s.string({ min: 1, max: 16 }), { max: 8 })),
      tileSize,
    }),
    s.object({
      ...base,
      kind: s.literal('wms'),
      url: httpsUrl,
      layers: s.string({ min: 1, max: 1024 }),
      styles: s.optional(s.string({ max: 1024 })),
      format: s.optional(s.enum(['image/png', 'image/jpeg', 'image/webp'] as const)),
      version: s.optional(s.enum(['1.1.1', '1.3.0'] as const)),
      transparent: s.optional(s.boolean()),
      parameters: s.optional(s.record(param, { keyPattern: /^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/, max: 16 })),
      tileSize,
    }),
    s.object({
      ...base,
      kind: s.literal('wmts'),
      url: httpsUrl,
      layer: s.string({ min: 1, max: 256 }),
      style: s.string({ min: 1, max: 256 }),
      format: s.string({ min: 1, max: 64 }),
      tileMatrixSet: s.string({ min: 1, max: 256 }),
      webMercator: s.optional(s.boolean()),
      tileMatrixLabels: s.optional(s.array(s.string({ min: 1, max: 64 }), { max: 31 })),
      tileSize,
    }),
  ]) as Schema<RasterOverlay>,
  (o) => {
    if (o.minZoom !== undefined && o.maxZoom !== undefined && o.minZoom > o.maxZoom)
      return 'minZoom must be <= maxZoom';
    if (o.kind === 'xyz' && !/\{z\}/.test(o.url)) return 'an xyz url needs {z}, {x} and {y}';
    if (o.kind === 'xyz' && !/\{x\}/.test(o.url)) return 'an xyz url needs {x}';
    if (o.kind === 'xyz' && !/\{-?y\}/.test(o.url)) return 'an xyz url needs {y} or {-y}';
    if (o.kind === 'xyz' && /\{s\}/.test(o.url) && !o.subdomains?.length) return '{s} in the url needs subdomains';
    if (o.kind === 'wms' && o.url.includes('?')) return 'a wms url is the GetMap endpoint without query parameters';
    return undefined;
  },
);

/** The host a renderer will fetch this overlay's tiles from. */
export function overlayHost(o: RasterOverlay): string {
  return new URL(o.url.replace(/\{[^}]*\}/g, 'x')).hostname.toLowerCase();
}

/**
 * The tile template for a 2D tile source: `{z}/{x}/{y}` (and `{s}`) for XYZ, a GetMap
 * request with `{bbox-epsg-3857}` for WMS (the source substitutes the tile's extent), and
 * `{z}/{x}/{y}` for a Web Mercator WMTS. Returns undefined when the 2D renderer cannot
 * draw the overlay (a WMTS on a matrix set that is not Web Mercator).
 */
export function overlayTileTemplate(o: RasterOverlay): string | undefined {
  const size = o.tileSize ?? 256;
  switch (o.kind) {
    case 'xyz':
      return o.url;
    case 'wms': {
      const version = o.version ?? '1.3.0';
      const q = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: version,
        REQUEST: 'GetMap',
        LAYERS: o.layers,
        STYLES: o.styles ?? '',
        FORMAT: o.format ?? 'image/png',
        TRANSPARENT: o.transparent === false ? 'FALSE' : 'TRUE',
        [version === '1.3.0' ? 'CRS' : 'SRS']: 'EPSG:3857',
        WIDTH: String(size),
        HEIGHT: String(size),
      });
      for (const [k, v] of Object.entries(o.parameters ?? {})) q.set(k, v);
      // BBOX last and unescaped: the tile source fills the placeholder in.
      return `${o.url}?${q.toString()}&BBOX={bbox-epsg-3857}`;
    }
    case 'wmts': {
      if (!(o.webMercator ?? isWebMercatorMatrixSet(o.tileMatrixSet))) return undefined;
      const matrix = matrixTemplate(o.tileMatrixLabels);
      if (!matrix) return undefined;
      if (o.url.includes('{TileMatrix}'))
        return o.url
          .replace('{TileMatrixSet}', o.tileMatrixSet)
          .replace('{Style}', o.style)
          .replace('{TileMatrix}', matrix)
          .replace('{TileRow}', '{y}')
          .replace('{TileCol}', '{x}');
      const q = new URLSearchParams({
        SERVICE: 'WMTS',
        REQUEST: 'GetTile',
        VERSION: '1.0.0',
        LAYER: o.layer,
        STYLE: o.style,
        FORMAT: o.format,
        TILEMATRIXSET: o.tileMatrixSet,
      });
      return `${o.url}${o.url.includes('?') ? '&' : '?'}${q.toString()}&TILEMATRIX=${matrix}&TILEROW={y}&TILECOL={x}`;
    }
  }
}

/**
 * `{z}` when the matrices are numbered by zoom (no labels), `<prefix>{z}` when every label
 * is the same prefix followed by its index written plainly (`EPSG:3857:0`, `EPSG:3857:1`, …),
 * otherwise nothing: a template cannot express an arbitrary label per zoom, and a padded
 * one (`00`, `05`) is not `{z}` — a service strict about its identifiers would refuse the
 * tile, so the set is reported rather than guessed at.
 */
export function matrixTemplate(labels: readonly string[] | undefined): string | undefined {
  if (!labels?.length) return '{z}';
  let prefix: string | undefined;
  for (const [i, label] of labels.entries()) {
    const m = /^(.*?)(\d+)$/.exec(label);
    if (!m || m[2] !== String(i)) return undefined;
    if (prefix === undefined) prefix = m[1];
    else if (prefix !== m[1]) return undefined;
  }
  return `${prefix ?? ''}{z}`;
}

/** Matrix sets a Web Mercator tile source can address by zoom number. */
export function isWebMercatorMatrixSet(name: string): boolean {
  return /3857|900913|googlemapscompatible|webmercator|web_mercator|osmtile/i.test(name);
}
