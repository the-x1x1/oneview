import type { GeoBounds } from '@worldview/world-model';
import {
  at,
  child,
  childText,
  childrenNamed,
  descendants,
  exceptionMessage,
  hrefIn,
  numberOf,
  scanXml,
  textOf,
  type XmlElement,
} from './xml.js';

/**
 * GetCapabilities for WMS (1.1.1, 1.3.0), WMTS (1.0.0) and WFS (1.1.0, 2.0.0), read with
 * the tolerant scanner in xml.ts and reduced to what the OGC connectors use. Written
 * against recorded documents from GeoServer, MapServer, QGIS Server, ArcGIS Server and a
 * national mapping agency (fixtures/connectors/ogc), following the capability items
 * TerriaJS's WMS/WMTS/WFS catalogue items learned to read (docs/architecture/TERRIAJS-HARVEST.md);
 * no Terria code is copied.
 *
 * A parser answers the capabilities, `{ exception }` for an OGC exception document (the
 * server's own words), or `{ malformed }` for anything else.
 */
export type ParseResult<T> = T | { exception: string } | { malformed: string };

export function isParsed<T extends object>(r: ParseResult<T>): r is T {
  return !('malformed' in r) && !('exception' in r);
}

export function parseProblem<T extends object>(r: ParseResult<T>): string | undefined {
  if ('exception' in r) return `the service answered with an exception: ${r.exception}`;
  if ('malformed' in r) return r.malformed;
  return undefined;
}

interface ServiceInfo {
  title?: string;
  fees?: string;
  accessConstraints?: string;
}

function root(
  text: string,
  expected: string[],
  what: string,
): XmlElement | { exception: string } | { malformed: string } {
  const scanned = scanXml(text);
  if ('malformed' in scanned) return { malformed: `not ${what} capabilities: ${scanned.malformed}` };
  const exception = exceptionMessage(scanned.root);
  if (exception) return { exception };
  if (!expected.includes(scanned.root.name))
    return { malformed: `not ${what} capabilities (the document is <${scanned.root.name}>)` };
  return scanned.root;
}

const clean = (s: string | undefined): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t && !/^none$/i.test(t) ? t : undefined;
};

/** `lon lat` pair from an ows:LowerCorner / UpperCorner. */
function corner(el: XmlElement | undefined): [number, number] | undefined {
  const parts = textOf(el)?.split(/\s+/).map(Number);
  return parts && parts.length >= 2 && parts.every(Number.isFinite) ? [parts[0]!, parts[1]!] : undefined;
}

function wgs84Box(el: XmlElement | undefined): GeoBounds | undefined {
  const lo = corner(child(el, 'LowerCorner'));
  const hi = corner(child(el, 'UpperCorner'));
  return lo && hi ? validBounds({ west: lo[0], south: lo[1], east: hi[0], north: hi[1] }) : undefined;
}

function validBounds(b: GeoBounds): GeoBounds | undefined {
  const ok =
    [b.west, b.south, b.east, b.north].every(Number.isFinite) &&
    Math.abs(b.south) <= 90 &&
    Math.abs(b.north) <= 90 &&
    Math.abs(b.west) <= 180 &&
    Math.abs(b.east) <= 180 &&
    b.south <= b.north;
  return ok ? b : undefined;
}

function owsService(r: XmlElement): ServiceInfo {
  const si = child(r, 'ServiceIdentification');
  const out: ServiceInfo = {};
  const title = clean(childText(si, 'Title'));
  const fees = clean(childText(si, 'Fees'));
  const access = clean(childText(si, 'AccessConstraints'));
  if (title) out.title = title;
  if (fees) out.fees = fees;
  if (access) out.accessConstraints = access;
  return out;
}

function owsOperation(r: XmlElement, name: string): XmlElement | undefined {
  return childrenNamed(child(r, 'OperationsMetadata'), 'Operation').find(
    (o) => (o.attrs['name'] ?? '').toLowerCase() === name.toLowerCase(),
  );
}

/** Values of an ows:Parameter (or ows:Constraint) with this name under `el`, any nesting of AllowedValues. */
function owsValues(el: XmlElement | undefined, kind: 'Parameter' | 'Constraint', name: string): string[] {
  const found = childrenNamed(el, kind).find((p) => (p.attrs['name'] ?? '').toLowerCase() === name.toLowerCase());
  return descendants(found, 'Value')
    .map((v) => textOf(v))
    .filter((v): v is string => v !== undefined);
}

function owsDefault(el: XmlElement | undefined, name: string): string | undefined {
  const found = childrenNamed(el, 'Constraint').find(
    (p) => (p.attrs['name'] ?? '').toLowerCase() === name.toLowerCase(),
  );
  return textOf(child(found, 'DefaultValue')) ?? textOf(descendants(found, 'Value')[0]);
}

// ── WMS ──────────────────────────────────────────────────────────────────────

export interface WmsStyle {
  name: string;
  title?: string;
  legendUrl?: string;
}

export interface WmsDimension {
  name: string;
  units?: string;
  default?: string;
  /** The values, as the server lists them (a list, or `start/end/period`). */
  extent?: string;
  current?: boolean;
}

export interface WmsLayer {
  /** Absent for a group that cannot be requested itself. */
  name?: string;
  title?: string;
  abstract?: string;
  /** Titles (or names) of the enclosing layers, outermost first. */
  path: string[];
  depth: number;
  /** Inherited and own CRS/SRS, as written. */
  crs: string[];
  bounds?: GeoBounds;
  /** Inherited and own. */
  styles: WmsStyle[];
  dimensions: WmsDimension[];
  attribution?: { title?: string; url?: string };
  minScaleDenominator?: number;
  maxScaleDenominator?: number;
  /** WMS 1.1.1: the ground size of a pixel's diagonal, in metres. */
  scaleHint?: { min?: number; max?: number };
  queryable: boolean;
  opaque: boolean;
}

export interface WmsCapabilities extends ServiceInfo {
  service: 'WMS';
  version: '1.1.1' | '1.3.0';
  getMapUrl?: string;
  getMapFormats: string[];
  layers: WmsLayer[];
}

interface WmsInherited {
  crs: string[];
  styles: WmsStyle[];
  dimensions: WmsDimension[];
  bounds?: GeoBounds;
  attribution?: { title?: string; url?: string };
  minScaleDenominator?: number;
  maxScaleDenominator?: number;
  scaleHint?: { min?: number; max?: number };
  queryable: boolean;
  opaque: boolean;
}

export const MAX_WMS_LAYERS = 20_000;

export function parseWmsCapabilities(text: string): ParseResult<WmsCapabilities> {
  const r = root(text, ['WMS_Capabilities', 'WMT_MS_Capabilities'], 'WMS');
  if (!('name' in r)) return r;
  const version = r.attrs['version']?.startsWith('1.3') ? '1.3.0' : r.name === 'WMS_Capabilities' ? '1.3.0' : '1.1.1';
  const service = child(r, 'Service');
  const getMap = at(r, 'Capability', 'Request', 'GetMap');
  const out: WmsCapabilities = {
    service: 'WMS',
    version,
    getMapFormats: childrenNamed(getMap, 'Format')
      .map((f) => textOf(f))
      .filter((f): f is string => f !== undefined),
    layers: [],
  };
  const title = clean(childText(service, 'Title'));
  const fees = clean(childText(service, 'Fees'));
  const access = clean(childText(service, 'AccessConstraints'));
  if (title) out.title = title;
  if (fees) out.fees = fees;
  if (access) out.accessConstraints = access;
  const href = hrefIn(at(getMap, 'DCPType', 'HTTP', 'Get'));
  if (href) out.getMapUrl = href;
  const top = childrenNamed(child(r, 'Capability'), 'Layer');
  if (top.length === 0) return { malformed: 'WMS capabilities without a Layer' };
  const base: WmsInherited = { crs: [], styles: [], dimensions: [], queryable: false, opaque: false };
  for (const l of top) walkWmsLayer(l, base, [], 0, out.layers);
  return out;
}

function walkWmsLayer(el: XmlElement, parent: WmsInherited, path: string[], depth: number, out: WmsLayer[]): void {
  if (out.length >= MAX_WMS_LAYERS) return;
  const own: WmsInherited = {
    crs: [...parent.crs],
    styles: [...parent.styles],
    dimensions: [...parent.dimensions],
    queryable: el.attrs['queryable'] !== undefined ? el.attrs['queryable'] === '1' : parent.queryable,
    opaque: el.attrs['opaque'] !== undefined ? el.attrs['opaque'] === '1' : parent.opaque,
  };
  // Replaced when the child declares its own, inherited otherwise (WMS 1.3.0 §7.2.4.8).
  if (parent.bounds) own.bounds = parent.bounds;
  if (parent.attribution) own.attribution = parent.attribution;
  if (parent.minScaleDenominator !== undefined) own.minScaleDenominator = parent.minScaleDenominator;
  if (parent.maxScaleDenominator !== undefined) own.maxScaleDenominator = parent.maxScaleDenominator;
  if (parent.scaleHint) own.scaleHint = parent.scaleHint;

  // Added: CRS (1.3.0) / SRS (1.1.1; old servers put several in one element).
  for (const c of [...childrenNamed(el, 'CRS'), ...childrenNamed(el, 'SRS')])
    for (const code of (textOf(c) ?? '').split(/\s+/))
      if (code && !own.crs.some((x) => x.toUpperCase() === code.toUpperCase())) own.crs.push(code);

  const ex = child(el, 'EX_GeographicBoundingBox');
  const ll = child(el, 'LatLonBoundingBox');
  if (ex) {
    const b = validBounds({
      west: numberOf(childText(ex, 'westBoundLongitude')) ?? NaN,
      south: numberOf(childText(ex, 'southBoundLatitude')) ?? NaN,
      east: numberOf(childText(ex, 'eastBoundLongitude')) ?? NaN,
      north: numberOf(childText(ex, 'northBoundLatitude')) ?? NaN,
    });
    if (b) own.bounds = b;
  } else if (ll) {
    const b = validBounds({
      west: numberOf(ll.attrs['minx']) ?? NaN,
      south: numberOf(ll.attrs['miny']) ?? NaN,
      east: numberOf(ll.attrs['maxx']) ?? NaN,
      north: numberOf(ll.attrs['maxy']) ?? NaN,
    });
    if (b) own.bounds = b;
  }

  for (const s of childrenNamed(el, 'Style')) {
    const name = childText(s, 'Name');
    if (!name) continue;
    const style: WmsStyle = { name };
    const t = clean(childText(s, 'Title'));
    const legend = hrefIn(child(s, 'LegendURL'));
    if (t) style.title = t;
    if (legend) style.legendUrl = legend;
    const i = own.styles.findIndex((x) => x.name === name);
    if (i >= 0) own.styles[i] = style;
    else own.styles.push(style);
  }

  // Dimensions: 1.3.0 carries the values on <Dimension>; 1.1.1 declares on <Dimension> and lists on <Extent>.
  for (const d of childrenNamed(el, 'Dimension')) {
    const name = d.attrs['name']?.toLowerCase();
    if (!name) continue;
    const dim: WmsDimension = { name };
    if (d.attrs['units']) dim.units = d.attrs['units'];
    if (d.attrs['default']) dim.default = d.attrs['default'];
    if (d.attrs['current']) dim.current = d.attrs['current'] === '1' || d.attrs['current'] === 'true';
    const extent = textOf(d);
    if (extent) dim.extent = extent.replace(/\s+/g, '');
    own.dimensions = [...own.dimensions.filter((x) => x.name !== name), dim];
  }
  for (const e of childrenNamed(el, 'Extent')) {
    const name = e.attrs['name']?.toLowerCase();
    if (!name) continue;
    const prev = own.dimensions.find((x) => x.name === name) ?? { name };
    const dim: WmsDimension = { ...prev };
    if (e.attrs['default']) dim.default = e.attrs['default'];
    const extent = textOf(e);
    if (extent) dim.extent = extent.replace(/\s+/g, '');
    own.dimensions = [...own.dimensions.filter((x) => x.name !== name), dim];
  }

  const attribution = child(el, 'Attribution');
  if (attribution) {
    const a: { title?: string; url?: string } = {};
    const t = clean(childText(attribution, 'Title'));
    const u = hrefIn(child(attribution, 'OnlineResource'));
    if (t) a.title = t;
    if (u) a.url = u;
    own.attribution = a;
  }
  const minS = numberOf(childText(el, 'MinScaleDenominator'));
  const maxS = numberOf(childText(el, 'MaxScaleDenominator'));
  if (minS !== undefined) own.minScaleDenominator = minS;
  if (maxS !== undefined) own.maxScaleDenominator = maxS;
  const hint = child(el, 'ScaleHint');
  if (hint) {
    const h: { min?: number; max?: number } = {};
    const lo = numberOf(hint.attrs['min']);
    const hi = numberOf(hint.attrs['max']);
    if (lo !== undefined) h.min = lo;
    if (hi !== undefined) h.max = hi;
    own.scaleHint = h;
  }

  const name = childText(el, 'Name');
  const title = clean(childText(el, 'Title'));
  const layer: WmsLayer = {
    path,
    depth,
    crs: own.crs,
    styles: own.styles,
    dimensions: own.dimensions,
    queryable: own.queryable,
    opaque: own.opaque,
  };
  if (name) layer.name = name;
  if (title) layer.title = title;
  const abstract = clean(childText(el, 'Abstract'));
  if (abstract) layer.abstract = abstract.slice(0, 500);
  if (own.bounds) layer.bounds = own.bounds;
  if (own.attribution) layer.attribution = own.attribution;
  if (own.minScaleDenominator !== undefined) layer.minScaleDenominator = own.minScaleDenominator;
  if (own.maxScaleDenominator !== undefined) layer.maxScaleDenominator = own.maxScaleDenominator;
  if (own.scaleHint) layer.scaleHint = own.scaleHint;
  out.push(layer);
  const childPath = [...path, title ?? name ?? '(untitled)'];
  for (const c of childrenNamed(el, 'Layer')) walkWmsLayer(c, own, childPath, depth + 1, out);
}

// ── WMTS ─────────────────────────────────────────────────────────────────────

export interface WmtsTileMatrix {
  identifier: string;
  scaleDenominator: number;
  /** As written: easting/northing for a projected CRS. */
  topLeft: [number, number];
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
}

export interface WmtsTileMatrixSet {
  identifier: string;
  supportedCrs: string;
  wellKnownScaleSet?: string;
  matrices: WmtsTileMatrix[];
}

export interface WmtsResourceUrl {
  format: string;
  resourceType: string;
  template: string;
}

export interface WmtsLayer {
  identifier: string;
  title?: string;
  bounds?: GeoBounds;
  formats: string[];
  styles: Array<{ identifier: string; isDefault: boolean; title?: string; legendUrl?: string }>;
  tileMatrixSets: string[];
  resourceUrls: WmtsResourceUrl[];
  dimensions: Array<{ identifier: string; default?: string; values: string[] }>;
}

export interface WmtsCapabilities extends ServiceInfo {
  service: 'WMTS';
  version: string;
  /** KVP GetTile endpoints (the `Get` hrefs whose encoding allows KVP, or say nothing). */
  kvpGetTileUrls: string[];
  layers: WmtsLayer[];
  tileMatrixSets: WmtsTileMatrixSet[];
}

export function parseWmtsCapabilities(text: string): ParseResult<WmtsCapabilities> {
  const r = root(text, ['Capabilities'], 'WMTS');
  if (!('name' in r)) return r;
  const contents = child(r, 'Contents');
  if (!contents) return { malformed: 'not WMTS capabilities (no Contents)' };
  const out: WmtsCapabilities = {
    service: 'WMTS',
    version: r.attrs['version'] ?? '1.0.0',
    ...owsService(r),
    kvpGetTileUrls: [],
    layers: [],
    tileMatrixSets: [],
  };
  for (const get of descendants(at(owsOperation(r, 'GetTile'), 'DCP', 'HTTP'), 'Get')) {
    const href = get.attrs['href'];
    const encodings = owsValues(get, 'Constraint', 'GetEncoding').map((v) => v.toUpperCase());
    if (href && (encodings.length === 0 || encodings.includes('KVP'))) out.kvpGetTileUrls.push(href.trim());
  }
  for (const l of childrenNamed(contents, 'Layer')) {
    const identifier = childText(l, 'Identifier');
    if (!identifier) continue;
    const layer: WmtsLayer = {
      identifier,
      formats: childrenNamed(l, 'Format')
        .map((f) => textOf(f))
        .filter((f): f is string => f !== undefined),
      styles: childrenNamed(l, 'Style')
        .map((s) => {
          const id = childText(s, 'Identifier');
          if (!id) return undefined;
          const style: WmtsLayer['styles'][number] = { identifier: id, isDefault: s.attrs['isDefault'] === 'true' };
          const t = clean(childText(s, 'Title'));
          const legend = hrefIn(child(s, 'LegendURL'));
          if (t) style.title = t;
          if (legend) style.legendUrl = legend;
          return style;
        })
        .filter((s): s is WmtsLayer['styles'][number] => s !== undefined),
      tileMatrixSets: childrenNamed(l, 'TileMatrixSetLink')
        .map((k) => childText(k, 'TileMatrixSet'))
        .filter((k): k is string => k !== undefined),
      resourceUrls: childrenNamed(l, 'ResourceURL')
        .map((u) => ({
          format: u.attrs['format'] ?? '',
          resourceType: u.attrs['resourceType'] ?? '',
          template: u.attrs['template'] ?? '',
        }))
        .filter((u) => u.template !== ''),
      dimensions: childrenNamed(l, 'Dimension')
        .map((d) => {
          const id = childText(d, 'Identifier');
          if (!id) return undefined;
          const dim: WmtsLayer['dimensions'][number] = {
            identifier: id,
            values: childrenNamed(d, 'Value')
              .map((v) => textOf(v))
              .filter((v): v is string => v !== undefined),
          };
          const def = childText(d, 'Default');
          if (def) dim.default = def;
          return dim;
        })
        .filter((d): d is WmtsLayer['dimensions'][number] => d !== undefined),
    };
    const title = clean(childText(l, 'Title'));
    if (title) layer.title = title;
    const bounds = wgs84Box(child(l, 'WGS84BoundingBox'));
    if (bounds) layer.bounds = bounds;
    out.layers.push(layer);
  }
  for (const s of childrenNamed(contents, 'TileMatrixSet')) {
    const identifier = childText(s, 'Identifier');
    const supportedCrs = childText(s, 'SupportedCRS');
    if (!identifier || !supportedCrs) continue;
    const set: WmtsTileMatrixSet = { identifier, supportedCrs, matrices: [] };
    const wkss = childText(s, 'WellKnownScaleSet');
    if (wkss) set.wellKnownScaleSet = wkss;
    for (const m of childrenNamed(s, 'TileMatrix')) {
      const id = childText(m, 'Identifier');
      const scale = numberOf(childText(m, 'ScaleDenominator'));
      const tl = textOf(child(m, 'TopLeftCorner'))?.split(/\s+/).map(Number);
      const tw = numberOf(childText(m, 'TileWidth'));
      const th = numberOf(childText(m, 'TileHeight'));
      const mw = numberOf(childText(m, 'MatrixWidth'));
      const mh = numberOf(childText(m, 'MatrixHeight'));
      if (!id || scale === undefined || !tl || tl.length < 2 || !tl.every(Number.isFinite)) continue;
      if (tw === undefined || th === undefined || mw === undefined || mh === undefined) continue;
      set.matrices.push({
        identifier: id,
        scaleDenominator: scale,
        topLeft: [tl[0]!, tl[1]!],
        tileWidth: tw,
        tileHeight: th,
        matrixWidth: mw,
        matrixHeight: mh,
      });
    }
    out.tileMatrixSets.push(set);
  }
  if (out.layers.length === 0) return { malformed: 'WMTS capabilities without a Layer' };
  return out;
}

// ── WFS ──────────────────────────────────────────────────────────────────────

export interface WfsFeatureType {
  name: string;
  title?: string;
  defaultCrs?: string;
  otherCrs: string[];
  bounds?: GeoBounds;
  outputFormats: string[];
}

export interface WfsCapabilities extends ServiceInfo {
  service: 'WFS';
  version: '1.1.0' | '2.0.0';
  getFeatureUrl?: string;
  /** GetFeature `outputFormat` values the service lists. */
  outputFormats: string[];
  /** WFS 2.0 CountDefault: the page size when a request names none. */
  countDefault?: number;
  implementsResultPaging?: boolean;
  featureTypes: WfsFeatureType[];
}

export function parseWfsCapabilities(text: string): ParseResult<WfsCapabilities> {
  const r = root(text, ['WFS_Capabilities'], 'WFS');
  if (!('name' in r)) return r;
  const v = r.attrs['version'] ?? '';
  if (!v.startsWith('2.0') && !v.startsWith('1.1'))
    return { malformed: `WFS ${v || '(no version)'} is not supported (1.1.0 and 2.0.0 are)` };
  const version = v.startsWith('2.0') ? '2.0.0' : '1.1.0';
  const om = child(r, 'OperationsMetadata');
  const getFeature = owsOperation(r, 'GetFeature');
  const outputFormats = [
    ...owsValues(getFeature, 'Parameter', 'outputFormat'),
    ...owsValues(om, 'Parameter', 'outputFormat'),
  ];
  const out: WfsCapabilities = {
    service: 'WFS',
    version,
    ...owsService(r),
    outputFormats: [...new Set(outputFormats)],
    featureTypes: [],
  };
  const href = descendants(at(getFeature, 'DCP', 'HTTP'), 'Get')[0]?.attrs['href'];
  if (href) out.getFeatureUrl = href.trim();
  const countDefault = numberOf(owsDefault(om, 'CountDefault') ?? owsDefault(getFeature, 'CountDefault'));
  if (countDefault !== undefined) out.countDefault = countDefault;
  const paging = owsDefault(om, 'ImplementsResultPaging');
  if (paging !== undefined) out.implementsResultPaging = /^true$/i.test(paging);
  for (const ft of childrenNamed(child(r, 'FeatureTypeList'), 'FeatureType')) {
    const name = childText(ft, 'Name');
    if (!name) continue;
    const type: WfsFeatureType = {
      name,
      otherCrs: [...childrenNamed(ft, 'OtherCRS'), ...childrenNamed(ft, 'OtherSRS')]
        .map((c) => textOf(c))
        .filter((c): c is string => c !== undefined),
      outputFormats: childrenNamed(child(ft, 'OutputFormats'), 'Format')
        .map((f) => textOf(f))
        .filter((f): f is string => f !== undefined),
    };
    const title = clean(childText(ft, 'Title'));
    const def = childText(ft, 'DefaultCRS') ?? childText(ft, 'DefaultSRS');
    const bounds = wgs84Box(child(ft, 'WGS84BoundingBox'));
    if (title) type.title = title;
    if (def) type.defaultCrs = def;
    if (bounds) type.bounds = bounds;
    out.featureTypes.push(type);
  }
  return out;
}

/** A feature type by name; a prefix-less name matches `prefix:name` when that is unambiguous. */
export function findFeatureType(caps: WfsCapabilities, name: string): WfsFeatureType | undefined {
  const exact = caps.featureTypes.find((f) => f.name === name);
  if (exact) return exact;
  if (name.includes(':')) return undefined;
  const local = caps.featureTypes.filter((f) => f.name.split(':').pop() === name);
  return local.length === 1 ? local[0] : undefined;
}
