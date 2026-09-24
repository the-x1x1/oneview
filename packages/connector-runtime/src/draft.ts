import { parseCsv } from './csv.js';
import { DEFINITION_SCHEMA_ID, type ConnectorProviderDefinition } from '@worldview/connector-sdk';

/**
 * The drafter (moved here from the connector-validator tool by the ADR-013 amendment of
 * 2026-09-23, so the desktop's main process can run it for the Add-source dialog; `pnpm
 * connector:add` imports it from here). From one sample of a source (its URL and body), a draft definition
 * the operator finishes by hand. The drafter recognises a GeoJSON FeatureCollection, a JSON
 * document with an array of records somewhere near the top, and CSV; it guesses the record
 * path, the id, the time and the position fields from their names, and writes everything
 * else fail-closed: `review: user-configured`, `enabled: false`, no data policy opened, no
 * attribution claimed. What it could not decide is listed in `todo` so nothing is invented.
 */
export interface DraftSample {
  url: string;
  contentType?: string;
  text: string;
}

export interface DraftOptions {
  id?: string;
  name?: string;
  objectType?: string;
  intervalSeconds?: number;
}

export interface DraftResult {
  definition: Record<string, unknown>;
  connector: string;
  todo: string[];
  notes: string[];
}

const ID_KEYS = [
  'id',
  'uid',
  'uuid',
  'guid',
  'station_id',
  'stationId',
  'device_id',
  'deviceId',
  'icao',
  'icao24',
  'mmsi',
  'callsign',
  'name',
  'code',
];
const TIME_KEYS = [
  'time',
  'timestamp',
  'observedAt',
  'observed_at',
  'updated',
  'updatedAt',
  'updated_at',
  'last_updated',
  'lastUpdated',
  'datetime',
  'date',
  'ts',
  'seen',
  'last_seen',
];
const LAT_KEYS = ['lat', 'latitude', 'y', 'Latitude', 'LAT'];
const LON_KEYS = ['lon', 'lng', 'long', 'longitude', 'x', 'Longitude', 'LON', 'LNG'];
const ALT_KEYS = ['alt', 'altitude', 'alt_m', 'altitudeM', 'elevation', 'height'];
const NAME_KEYS = ['name', 'title', 'label', 'station_name', 'callsign', 'description'];
const MAX_SAMPLE_KEYS = 40;

export function slugFromUrl(url: string): string {
  const u = new URL(url);
  const host =
    u.hostname
      .replace(/^www\./, '')
      .split('.')
      .slice(0, -1)
      .join('-') || u.hostname;
  const last =
    u.pathname
      .split('/')
      .filter(Boolean)
      .pop()
      ?.replace(/\.[a-z0-9]+$/i, '') ?? '';
  return `${host}${last ? `-${last}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function findArray(doc: unknown, depth = 0, prefix = ''): { path: string; items: unknown[] } | undefined {
  if (Array.isArray(doc))
    return doc.length && doc.every((x) => x && typeof x === 'object') ? { path: prefix, items: doc } : undefined;
  if (!doc || typeof doc !== 'object' || depth > 3) return undefined;
  let best: { path: string; items: unknown[] } | undefined;
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const found = findArray(v, depth + 1, prefix ? `${prefix}.${k}` : k);
    if (found && (!best || found.items.length > best.items.length)) best = found;
  }
  return best;
}

function pick(keys: string[], candidates: string[]): string | undefined {
  for (const k of keys) if (candidates.includes(k)) return k;
  const lower = candidates.map((c) => c.toLowerCase());
  for (const k of keys) {
    const i = lower.indexOf(k.toLowerCase());
    if (i >= 0) return candidates[i];
  }
  return undefined;
}

function looksLikeTime(v: unknown): boolean {
  if (typeof v === 'number') return v > 1e9;
  if (typeof v !== 'string') return false;
  return !Number.isNaN(Date.parse(v)) || /^\d{10,13}$/.test(v);
}

export function draftDefinition(sample: DraftSample, opts: DraftOptions = {}): DraftResult {
  const todo: string[] = [];
  const notes: string[] = [];
  const type = (sample.contentType ?? '').toLowerCase();
  const url = new URL(sample.url);
  const id = opts.id ?? slugFromUrl(sample.url);
  const base: Record<string, unknown> = {
    schema: DEFINITION_SCHEMA_ID,
    id,
    name: opts.name ?? `${url.hostname} (draft)`,
    description: `Drafted by connector:add from ${sample.url}. Finish the mapping, the object type, the attribution and the terms before enabling.`,
    connector: 'rest-json',
    objectType: opts.objectType ?? 'place',
    categories: [],
    endpoint: { url: sample.url, intervalSeconds: opts.intervalSeconds ?? 300 },
    mapping: {},
    attribution: { text: `${url.hostname} — attribution to be confirmed` },
    review: 'user-configured',
    enabled: false,
  };
  if (!opts.objectType)
    todo.push(
      'objectType: "place" is a placeholder; pick the type this source describes (aircraft, vessel, sensor, …)',
    );
  todo.push('attribution.text and termsUrl: name the licence and the rights holder before this source is shown');
  todo.push('freshness: set liveSeconds/recentSeconds/expireSeconds for how quickly this source goes stale');

  let records: Array<Record<string, unknown>> = [];
  let json: unknown;
  const isCsv = type.includes('csv') || (!type.includes('json') && looksLikeCsv(sample.text));
  if (isCsv) {
    const csv = parseCsv(sample.text, { maxRows: 50 });
    if (csv.malformed) throw new Error(`the sample did not parse as CSV: ${csv.malformed}`);
    base['connector'] = 'csv';
    base['response'] = { format: 'csv' };
    records = csv.records;
    notes.push(
      `CSV with ${csv.columns.length} column(s): ${csv.columns.slice(0, 12).join(', ')}${csv.columns.length > 12 ? ', …' : ''}`,
    );
  } else {
    try {
      json = JSON.parse(sample.text);
    } catch {
      throw new Error('the sample is neither JSON nor CSV; only those are drafted');
    }
    const gj = json as { type?: unknown; features?: unknown };
    if (gj && typeof gj === 'object' && gj.type === 'FeatureCollection' && Array.isArray(gj.features)) {
      base['connector'] = 'geojson';
      records = gj.features
        .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
        .map((f) => ({ ...((f['properties'] as Record<string, unknown>) ?? {}), _feature: f }));
      notes.push(`GeoJSON FeatureCollection with ${gj.features.length} feature(s); positions come from the geometry`);
    } else {
      const found = findArray(json);
      if (!found) throw new Error('no array of records found in the JSON (looked three levels deep)');
      base['response'] = found.path ? { itemsPath: found.path } : {};
      records = found.items as Array<Record<string, unknown>>;
      notes.push(`${found.items.length} record(s) at ${found.path || 'the top level'}`);
    }
  }
  const first = records[0] ?? {};
  const keys = Object.keys(first).filter((k) => k !== '_feature');
  const mapping: Record<string, unknown> = {};
  const idKey = pick(ID_KEYS, keys);
  if (base['connector'] === 'geojson') {
    const feature = first['_feature'] as Record<string, unknown> | undefined;
    const hasId = Boolean(feature && feature['id'] !== undefined);
    if (hasId)
      notes.push(
        'features carry an id; it is the external id' + (idKey ? `, falling back to properties.${idKey}` : ''),
      );
    mapping['externalId'] = idKey ? { path: 'id', fallback: `properties.${idKey}` } : 'id';
    if (!hasId && !idKey)
      todo.push('mapping.externalId: no feature id and no id-like property; name the field that identifies a feature');
    mapping['position'] = { geometry: 'geometry' };
  } else {
    if (idKey) mapping['externalId'] = idKey;
    else todo.push('mapping.externalId: no id-like field found; name the field that identifies a record');
    const lat = pick(LAT_KEYS, keys);
    const lon = pick(LON_KEYS, keys);
    if (lat && lon) {
      const position: Record<string, unknown> = { lat, lon };
      const alt = pick(ALT_KEYS, keys);
      if (alt) position['alt'] = alt;
      mapping['position'] = position;
    } else {
      const geom = keys.find((k) => {
        const v = first[k];
        return v && typeof v === 'object' && 'coordinates' in (v as object);
      });
      if (geom) mapping['position'] = { geometry: geom };
      else
        todo.push(
          'mapping.position: no latitude/longitude fields recognised; name them (lat/lon), a geometry, or a [lon, lat] array',
        );
    }
  }
  const prefix = base['connector'] === 'geojson' ? 'properties.' : '';
  const timeKey = keys.find((k) => TIME_KEYS.includes(k) && looksLikeTime(first[k])) ?? pick(TIME_KEYS, keys);
  if (timeKey) {
    const v = first[timeKey];
    const transform = typeof v === 'number' ? (v > 1e11 ? 'unixMillis' : 'unixSeconds') : 'isoTimestamp';
    mapping['observedAt'] = { path: `${prefix}${timeKey}`, transform };
    notes.push(`observedAt from ${timeKey} (${transform}); check the epoch and time zone`);
  } else
    todo.push('mapping.observedAt: no time field recognised; without one every observation carries the fetch time');
  const nameKey = pick(NAME_KEYS, keys);
  if (nameKey) mapping['labels'] = { name: `${prefix}${nameKey}` };
  const properties: Record<string, unknown> = {};
  for (const k of keys.slice(0, MAX_SAMPLE_KEYS)) {
    if ([idKey, timeKey, nameKey].includes(k)) continue;
    if (LAT_KEYS.includes(k) || LON_KEYS.includes(k) || ALT_KEYS.includes(k)) continue;
    const v = first[k];
    if (v && typeof v === 'object') continue;
    const camel = k.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()).replace(/^[^A-Za-z_]+/, '');
    if (!camel) continue;
    properties[camel] =
      base['connector'] === 'csv' && typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))
        ? { path: k, transform: 'number' }
        : `${prefix}${k}`;
  }
  if (Object.keys(properties).length) mapping['properties'] = properties;
  if (keys.length > MAX_SAMPLE_KEYS)
    notes.push(`only the first ${MAX_SAMPLE_KEYS} of ${keys.length} fields were drafted as properties`);
  base['mapping'] = mapping;
  return { definition: base, connector: String(base['connector']), todo, notes };
}

function looksLikeCsv(text: string): boolean {
  const head = text.slice(0, 2000).trimStart();
  if (!head || head.startsWith('{') || head.startsWith('[') || head.startsWith('<')) return false;
  const lines = head.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const commas = lines[0]!.split(',').length;
  return commas > 1 && lines[1]!.split(',').length >= Math.max(2, commas - 1);
}

export type { ConnectorProviderDefinition };
