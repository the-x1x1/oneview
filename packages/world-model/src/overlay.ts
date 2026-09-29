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
  /**
   * `basemap`: a whole map (a topographic sheet, TopPlusOpen) rather than a layer to lay over
   * one. The shell offers it among the basemaps and draws it alone, never stacked on another
   * map; stacked, two opaque maps covered each other. Absent: an overlay.
   */
  role?: 'overlay' | 'basemap';
  /**
   * For a layer that steps through time (radar, satellite), the instant this descriptor
   * shows, as the service writes it (`2026-09-28T15:50:00Z`). Set by a connector that follows
   * the newest frame (`time: "latest"`); a new frame is a new descriptor with a new id and
   * this instant written where the service takes it — a WMS `TIME`, a WMTS tile path. Two
   * descriptors that differ only there are frames of one layer (`overlaySeries`), which the
   * renderers lay one over the other rather than swap with a blink. Absent: not time-stepped.
   */
  frame?: string;
  /**
   * Draw only what is brighter than the background: a pixel whose brightest channel is at or
   * below `from` (0–255) is transparent, at or above `to` opaque, and in between partly so.
   * For infrared satellite imagery, where clear sky and warm ground are a flat grey and cloud
   * is brighter or coloured: with it the overlay is the clouds alone, not a grey sheet over
   * the map with a hard edge where the satellite's view ends.
   */
  fadeBelow?: { from: number; to: number; monochrome?: boolean };
  /**
   * Degrees of longitude across which this slice cross-fades with its neighbour at its west
   * and east edges (render-core brightness-fade.ts `featherWeights`): it is drawn half this
   * wider than `bounds` each side, fading out across the edge, so two satellites meeting at a
   * seam blend instead of cutting along a line. Only with `bounds`.
   */
  featherDeg?: number;
  /**
   * The map zoom from which the layer is hidden (MapLibre's layer `maxzoom`). For a
   * picture whose pixels are kilometres across (IMERG precipitation, 0.1°): at a city's or an
   * airport's scale it is no longer weather to read but a sheet of coloured squares over the
   * map, hiding what the operator zoomed in to see. Unlike `maxZoom` (the deepest tiles asked
   * for, stretched beyond), this takes the layer away.
   */
  hideAboveZoom?: number;
}

/**
 * Where the overlay is drawn: its `bounds`, widened by half its `featherDeg` at the west and
 * east edges (latitudes as they are), but never past 180° either way. A slice meeting the
 * antimeridian was once widened across it (`west > east`), and neither renderer drew such a
 * box: on 2026-09-29 GOES-West and Himawari-9 fetched two tiles each on the globe and drew
 * next to nothing over the Pacific. At 180° the two slices meet edge to edge instead, unfeathered
 * (render-core `featherWeights`). Undefined without bounds.
 */
export function drawnBounds(o: Pick<RasterOverlay, 'bounds' | 'featherDeg'>): GeoBounds | undefined {
  const b = o.bounds;
  if (!b) return undefined;
  const half = (o.featherDeg ?? 0) / 2;
  if (!(half > 0) || b.west > b.east) return b;
  return { ...b, west: Math.max(-180, b.west - half), east: Math.min(180, b.east + half) };
}

/** True for an overlay that is a whole map, chosen as the basemap rather than drawn over one. */
export function isBasemapOverlay(o: RasterOverlay): boolean {
  return o.role === 'basemap';
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
  /**
   * The same template at the frame before this one, for a tile this frame does not have.
   * NASA GIBS lists a frame before every tile of it is rendered, and some are missing for
   * a long while (on 2026-09-29 a fifth of GOES-East's tiles over South America answered 404
   * ten minutes after the frame was listed); the globe drew those squares from coarser tiles,
   * as blocks. On the same host as `url`, and not part of the overlay's series.
   */
  fallbackUrl?: string;
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
  role: s.optional(s.enum(['overlay', 'basemap'] as const)),
  frame: s.optional(s.string({ min: 1, max: 64 })),
  fadeBelow: s.optional(
    s.refine(
      s.object({
        from: s.number({ min: 0, max: 255 }),
        to: s.number({ min: 0, max: 255 }),
        monochrome: s.optional(s.boolean()),
      }),
      (r) => (r.from < r.to ? undefined : 'from must be below to'),
    ),
  ),
  featherDeg: s.optional(s.number({ min: 0, max: 30 })),
  hideAboveZoom: s.optional(s.number({ min: 0, max: 30 })),
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
      fallbackUrl: s.optional(httpsUrl),
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
    if (o.kind === 'wmts' && o.fallbackUrl !== undefined && hostOfTemplate(o.fallbackUrl) !== hostOfTemplate(o.url))
      return 'a fallbackUrl must be on the same host as the url';
    return undefined;
  },
);

/**
 * What stays the same between two frames of one overlay: everything but its id, its `frame`,
 * a WMS `TIME` parameter and the frame's instant where it is written into the url (a WMTS
 * tile path, as written or percent-encoded). A radar or satellite source publishes a new
 * descriptor with every frame, and it is the same layer advancing, not a new one: both
 * renderers keep a series' layer in place and hand a new frame over on top of the old one.
 */
export function overlaySeries(o: RasterOverlay): string {
  const parameters = o.kind === 'wms' && o.parameters ? { ...o.parameters } : undefined;
  if (parameters) for (const k of Object.keys(parameters)) if (k.toUpperCase() === 'TIME') delete parameters[k];
  let url = o.url;
  if (o.frame) {
    const spellings = [o.frame, encodeURIComponent(o.frame), encodeURIComponent(o.frame).replace(/%3A/gi, ':')];
    for (const spelling of new Set(spellings)) url = url.split(spelling).join('{frame}');
  }
  const { id: _id, frame: _frame, ...rest } = o;
  if (rest.kind === 'wmts') delete (rest as { fallbackUrl?: string }).fallbackUrl;
  return JSON.stringify({ ...rest, url, ...(parameters ? { parameters } : {}) });
}

function hostOfTemplate(url: string): string | undefined {
  try {
    return new URL(url.replace(/\{[^}]*\}/g, 'x')).hostname.toLowerCase();
  } catch {
    return undefined; // not a URL: the schema's own check on it says so
  }
}

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
      if (!wmtsWebMercator(o)) return undefined;
      const matrix = matrixTemplate(o.tileMatrixLabels);
      if (!matrix) return undefined;
      // A label with a space (`EPSG:3857 - 512:{z}`) is escaped as the globe's requests are;
      // colons and the placeholder stay as they are.
      return wmtsTemplate(o, encodeURIComponent(matrix).replace(/%3A/gi, ':').replace('%7Bz%7D', '{z}'));
    }
  }
}

function wmtsWebMercator(o: WmtsOverlay): boolean {
  return o.webMercator ?? isWebMercatorMatrixSet(o.tileMatrixSet);
}

/** A WMTS GetTile template with `matrix` for the TileMatrix and `{x}`/`{y}` for the tile. */
function wmtsTemplate(o: WmtsOverlay, matrix: string): string {
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

/**
 * The URL of one tile of a Web Mercator WMTS whose matrices a `{z}` template cannot name
 * (zero-padded labels such as BKG's `00`…`18`): the label for zoom `z` is written in whole.
 * Undefined when the set is not Web Mercator or has no matrix at that zoom.
 */
export function wmtsTileUrl(o: WmtsOverlay, z: number, x: number, y: number): string | undefined {
  if (!wmtsWebMercator(o)) return undefined;
  const label = o.tileMatrixLabels ? o.tileMatrixLabels[z] : String(z);
  if (label === undefined) return undefined;
  return wmtsTemplate(o, encodeURIComponent(label).replace(/%3A/gi, ':'))
    .split('{x}')
    .join(String(x))
    .split('{y}')
    .join(String(y));
}

/** True when the 2D map can draw this WMTS only tile by tile (`wmtsTileUrl`), not by template. */
export function wmtsNeedsTileUrls(o: RasterOverlay): o is WmtsOverlay {
  return o.kind === 'wmts' && wmtsWebMercator(o) && !matrixTemplate(o.tileMatrixLabels) && !!o.tileMatrixLabels?.length;
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
