import type { JsonValue } from '@worldview/world-model';
import { parsePath, type ConnectorProviderDefinition, type Field, type PathSegment } from '@worldview/connector-sdk';
import { ESRI_DATE_FIELD, ESRI_OID_FIELD, parseEsriFields, type EsriField } from './esri-json.js';

/**
 * An ArcGIS layer's own description (`…/FeatureServer/{layer}?f=json`, the same for a
 * MapServer layer): what the query connector needs to ask correctly — the object id field,
 * the field types (dates are epoch milliseconds), the page size the server allows, whether
 * it pages at all, which formats it answers — and what a reviewer wants to see: the
 * extent, `copyrightText` (an attribution hint) and `drawingInfo` (kept, not used: symbology
 * is a renderer concern). Read once and refreshed now and then, never per page.
 */
export interface ArcGisLayerInfo {
  currentVersion?: number;
  id?: number;
  name?: string;
  /** `Feature Layer`, `Table`, `Group Layer`, `Raster Layer`, … */
  type?: string;
  geometryType?: string;
  objectIdField?: string;
  globalIdField?: string;
  fields: EsriField[];
  maxRecordCount?: number;
  /** Lower-cased: `json`, `geojson`, `pbf`, `amf`. */
  supportedQueryFormats: string[];
  /** Lower-cased: `query`, `create`, `extract`, … */
  capabilities: string[];
  /** Undefined when the layer does not say (before 10.3 it cannot page). */
  supportsPagination?: boolean;
  supportsOrderBy?: boolean;
  extent?: { xmin: number; ymin: number; xmax: number; ymax: number; wkid?: number };
  copyrightText?: string;
  /** Recorded as the server sent it; not used. */
  drawingInfo?: JsonValue;
}

/** Where one layer is: `…/FeatureServer/<n>` or `…/MapServer/<n>`, with or without `/query`. */
export interface LayerEndpoint {
  service: 'FeatureServer' | 'MapServer';
  layerId: number;
  /** The layer's URL, no trailing slash, no query string. */
  layerUrl: string;
  queryUrl: string;
}

const LAYER_PATH = /^(.*\/(featureserver|mapserver))\/(\d{1,6})(?:\/query)?\/?$/i;

/** The layer an endpoint URL names, or why it names none. */
export function layerEndpoint(url: string): LayerEndpoint | { error: string } {
  let u: URL;
  try {
    u = new URL(url.replace('{TOKEN}', 'TOKEN'));
  } catch {
    return { error: 'endpoint.url is not a URL' };
  }
  if (u.search) return { error: 'endpoint.url carries a query string; put ArcGIS parameters in endpoint.query' };
  if (u.hash) return { error: 'endpoint.url carries a fragment' };
  const m = LAYER_PATH.exec(u.pathname);
  if (!m)
    return {
      error:
        'endpoint.url must name one layer: …/FeatureServer/<layer> or …/MapServer/<layer> (optionally ending in /query)',
    };
  const service = m[2]!.toLowerCase() === 'featureserver' ? 'FeatureServer' : 'MapServer';
  const layerUrl = `${u.origin}${m[1]}/${m[3]}`;
  return { service, layerId: Number(m[3]), layerUrl, queryUrl: `${layerUrl}/query` };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const list = (v: unknown): string[] =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

/** Keys only a layer description has; a query response (which also has `fields`) has `features` instead. */
const LAYER_KEYS = ['supportedQueryFormats', 'maxRecordCount', 'capabilities', 'objectIdField', 'drawingInfo'];

/**
 * A parsed layer description, or `notLayer` with the reason when the body is JSON but not a
 * layer's description (the caller decides whether that is fatal).
 */
export function parseLayerInfo(body: unknown): { info: ArcGisLayerInfo } | { notLayer: string } {
  if (!isObj(body)) return { notLayer: 'layer description is not a JSON object' };
  if (Array.isArray(body['features'])) return { notLayer: 'the body is a feature set, not a layer description' };
  const known =
    LAYER_KEYS.some((k) => k in body) || (typeof body['type'] === 'string' && Array.isArray(body['fields']));
  if (!known) return { notLayer: 'the body has none of the keys of a layer description' };
  const fields = parseEsriFields(body['fields']);
  const info: ArcGisLayerInfo = {
    fields,
    supportedQueryFormats: list(body['supportedQueryFormats']),
    capabilities: list(body['capabilities']),
  };
  const version = num(body['currentVersion']);
  if (version !== undefined) info.currentVersion = version;
  const id = num(body['id']);
  if (id !== undefined) info.id = id;
  const name = str(body['name']);
  if (name) info.name = name;
  const type = str(body['type']);
  if (type) info.type = type;
  const geometryType = str(body['geometryType']);
  if (geometryType) info.geometryType = geometryType;
  const oid = str(body['objectIdField']) ?? fields.find((f) => f.type === ESRI_OID_FIELD)?.name;
  if (oid) info.objectIdField = oid;
  const gid = str(body['globalIdField']) ?? fields.find((f) => f.type === 'esriFieldTypeGlobalID')?.name;
  if (gid) info.globalIdField = gid;
  const max = num(body['maxRecordCount']);
  if (max !== undefined && max > 0) info.maxRecordCount = Math.floor(max);
  const adv = isObj(body['advancedQueryCapabilities']) ? body['advancedQueryCapabilities'] : undefined;
  if (adv && typeof adv['supportsPagination'] === 'boolean') info.supportsPagination = adv['supportsPagination'];
  else if (!adv && version !== undefined && version < 10.3) info.supportsPagination = false;
  if (adv && typeof adv['supportsOrderBy'] === 'boolean') info.supportsOrderBy = adv['supportsOrderBy'];
  const ext = isObj(body['extent']) ? body['extent'] : undefined;
  if (ext) {
    const [xmin, ymin, xmax, ymax] = [num(ext['xmin']), num(ext['ymin']), num(ext['xmax']), num(ext['ymax'])];
    if (xmin !== undefined && ymin !== undefined && xmax !== undefined && ymax !== undefined) {
      const sr = isObj(ext['spatialReference']) ? ext['spatialReference'] : {};
      const wkid = num(sr['latestWkid']) ?? num(sr['wkid']);
      info.extent = { xmin, ymin, xmax, ymax, ...(wkid !== undefined ? { wkid } : {}) };
    }
  }
  const copyright = str(body['copyrightText']);
  if (copyright) info.copyrightText = copyright.trim();
  if (body['drawingInfo'] !== undefined) info.drawingInfo = body['drawingInfo'] as JsonValue;
  return { info };
}

/**
 * `geojson` when the layer lists geoJSON among its query formats; `json` (esriJSON) when it
 * lists formats without it, or says nothing and is older than 10.4; `geojson` when nothing
 * is known (the response is read in whichever format comes back).
 */
export function preferredFormat(info: ArcGisLayerInfo | undefined): 'geojson' | 'json' {
  if (!info) return 'geojson';
  if (info.supportedQueryFormats.length) return info.supportedQueryFormats.includes('geojson') ? 'geojson' : 'json';
  if (info.currentVersion !== undefined && info.currentVersion < 10.4) return 'json';
  return 'geojson';
}

export function layerDateFields(info: ArcGisLayerInfo | undefined): Set<string> {
  return new Set((info?.fields ?? []).filter((f) => f.type === ESRI_DATE_FIELD).map((f) => f.name));
}

const LAYER_TYPES_WITH_FEATURES = new Set(['feature layer', 'table']);

/**
 * What a definition gets wrong about the layer it names, as warnings: fields the mapping or
 * `outFields` names that the layer does not have, date fields read with a transform that
 * refuses the ISO strings the connector delivers, an id that is not the layer's GlobalID when
 * the layer has one, `copyrightText` that the attribution does not carry, and layers that
 * cannot answer a feature query. None of these stops a poll; they are logged when the layer
 * description is read, so `connector:test --live` prints them.
 */
export function checkLayerInfo(d: ConnectorProviderDefinition, info: ArcGisLayerInfo): string[] {
  const warnings: string[] = [];
  const names = new Map(info.fields.map((f) => [f.name.toLowerCase(), f]));
  const hasFields = info.fields.length > 0;
  if (info.type && !LAYER_TYPES_WITH_FEATURES.has(info.type.toLowerCase()))
    warnings.push(`the layer is a ${info.type}, which has no features to query`);
  if (info.capabilities.length && !info.capabilities.includes('query'))
    warnings.push(`the layer's capabilities (${info.capabilities.join(', ')}) do not include Query`);
  if (info.type?.toLowerCase() === 'table' || (hasFields && !info.geometryType))
    if (usesGeometry(d)) warnings.push('the layer has no geometry (a table); map position from attribute fields');
  if (info.supportsPagination === false)
    warnings.push(
      `the layer cannot page (no resultOffset): each poll reads at most ${info.maxRecordCount ?? 'maxRecordCount'} features`,
    );
  if (hasFields) {
    for (const [where, field] of mappedFields(d)) {
      const name = propertyName(field);
      if (!name) continue;
      const f = names.get(name.toLowerCase());
      if (!f) {
        warnings.push(`${where} reads properties.${name}, which is not one of the layer's fields`);
        continue;
      }
      if (f.name !== name)
        warnings.push(
          `${where} reads properties.${name}; the layer's field is spelled ${f.name} (paths are case-sensitive)`,
        );
      if (f.type === ESRI_DATE_FIELD && transformsOf(field).some((t) => t === 'unixMillis' || t === 'unixSeconds'))
        warnings.push(
          `${where}: ${f.name} is a date field, which the connector delivers as ISO 8601 — use isoTimestamp (unixMillis would drop it)`,
        );
    }
    const outFields = d.endpoint?.query?.['outFields'];
    if (typeof outFields === 'string' && outFields.trim() !== '*')
      for (const n of outFields
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean))
        if (!names.has(n.toLowerCase())) warnings.push(`outFields names ${n}, which is not one of the layer's fields`);
  }
  const idName = propertyName(d.mapping.externalId);
  if (info.globalIdField && idName && idName.toLowerCase() === info.objectIdField?.toLowerCase())
    warnings.push(
      `mapping.externalId reads the object id (${idName}); the layer has a GlobalID field (${info.globalIdField}), which survives republishing`,
    );
  if (info.copyrightText && !d.attribution.text.toLowerCase().includes(info.copyrightText.toLowerCase().slice(0, 60)))
    warnings.push(
      `the layer's copyrightText is "${info.copyrightText.slice(0, 200)}" — consider it for attribution.text`,
    );
  return warnings;
}

function usesGeometry(d: ConnectorProviderDefinition): boolean {
  const p = d.mapping.position;
  return !p || 'geometry' in p;
}

/** Every field the mapping reads, with where it is read. */
function mappedFields(d: ConnectorProviderDefinition): Array<[string, Field]> {
  const m = d.mapping;
  const out: Array<[string, Field]> = [['mapping.externalId', m.externalId]];
  if (m.observedAt) out.push(['mapping.observedAt', m.observedAt]);
  if (m.position && 'lat' in m.position) {
    out.push(['mapping.position.lat', m.position.lat], ['mapping.position.lon', m.position.lon]);
    if (m.position.alt) out.push(['mapping.position.alt', m.position.alt]);
  }
  for (const [k, f] of Object.entries(m.labels ?? {})) out.push([`mapping.labels.${k}`, f]);
  for (const [k, f] of Object.entries(m.properties ?? {})) out.push([`mapping.properties.${k}`, f]);
  for (const [k, f] of Object.entries(m.motion ?? {})) if (f) out.push([`mapping.motion.${k}`, f]);
  return out;
}

/** The attribute a field reads, when its (first) path is `properties.<name>`. */
export function propertyName(field: Field | undefined): string | undefined {
  if (field === undefined) return undefined;
  const path = typeof field === 'string' ? field : field.path;
  if (!path) return undefined;
  let segments: PathSegment[];
  try {
    segments = parsePath(path);
  } catch {
    return undefined;
  }
  const [a, b] = segments;
  return segments.length === 2 && a && 'key' in a && a.key === 'properties' && b && 'key' in b ? b.key : undefined;
}

function transformsOf(field: Field): string[] {
  if (typeof field === 'string' || field.transform === undefined) return [];
  return Array.isArray(field.transform) ? field.transform : [field.transform];
}
