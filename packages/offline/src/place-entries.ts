import { isValidBounds, type GeoBounds, type JsonValue } from '@worldview/world-model';
import { featurePosition, numberProp, stringArrayProp, stringProp, type PackFeature, type PackFeatureCollection } from './geojson.js';
import type { PlaceEntry, PlaceKind } from './place-index.js';

/**
 * Turn the place / airport GeoJSON layers of a pack into PlaceIndex entries.
 * Features without a name or a usable position are skipped and counted, never fatal.
 */
export interface PlaceConversionReport { entries: PlaceEntry[]; skipped: number }

const KINDS: ReadonlySet<string> = new Set<PlaceKind>(['country', 'region', 'city', 'airport', 'port', 'feature', 'poi']);

export function placesFromFeatures(collection: PackFeatureCollection): PlaceConversionReport {
  const entries: PlaceEntry[] = [];
  let skipped = 0;
  for (const f of collection.features) {
    const e = placeFromFeature(f);
    if (e) entries.push(e); else skipped++;
  }
  return { entries, skipped };
}

export function placeFromFeature(f: PackFeature): PlaceEntry | undefined {
  const props = f.properties;
  const name = stringProp(props, 'name');
  const position = featurePosition(f);
  if (!name || !position) return undefined;
  const kindRaw = stringProp(props, 'kind');
  const kind: PlaceKind = kindRaw && KINDS.has(kindRaw) ? (kindRaw as PlaceKind) : 'poi';
  const id = stringProp(props, 'id') ?? (typeof f.id === 'string' ? f.id : typeof f.id === 'number' ? `feature:${f.id}` : undefined);
  if (!id) return undefined;
  const entry: PlaceEntry = {
    id, name, kind,
    altNames: stringArrayProp(props, 'altNames'),
    position: { latitude: position.latitude, longitude: position.longitude },
    importance: clamp01(numberProp(props, 'importance') ?? 0.3),
  };
  const iata = code(props['iata'], 3);
  const icao = code(props['icao'], 4);
  const cc = code(props['countryCode'], 2);
  if (iata) entry.iata = iata;
  if (icao) entry.icao = icao;
  if (cc && /^[A-Z]{2}$/.test(cc)) entry.countryCode = cc;
  const bounds = boundsProp(props['bounds']);
  if (bounds) entry.bounds = bounds;
  return entry;
}

/** Airport layer (`fixtures/airports` schema): Point features with iata/icao/name/municipality. */
export function airportsFromFeatures(collection: PackFeatureCollection): PlaceConversionReport {
  const entries: PlaceEntry[] = [];
  let skipped = 0;
  for (const f of collection.features) {
    const props = f.properties;
    const name = stringProp(props, 'name');
    const position = featurePosition(f);
    const icao = code(props['icao'], 4);
    const iata = code(props['iata'], 3);
    if (!name || !position || (!icao && !iata)) { skipped++; continue; }
    const id = stringProp(props, 'id') ?? `airport:${icao ?? iata}`;
    const municipality = stringProp(props, 'municipality');
    const entry: PlaceEntry = {
      id, name, kind: 'airport',
      altNames: municipality ? [`${municipality} Airport`] : [],
      position: { latitude: position.latitude, longitude: position.longitude },
      importance: 0.5,
    };
    if (iata) entry.iata = iata;
    if (icao) entry.icao = icao;
    const cc = code(props['countryCode'], 2);
    if (cc && /^[A-Z]{2}$/.test(cc)) entry.countryCode = cc;
    entries.push(entry);
  }
  return { entries, skipped };
}

function code(v: JsonValue | undefined, len: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const up = v.trim().toUpperCase();
  return up.length === len && /^[A-Z0-9]+$/.test(up) ? up : undefined;
}

function boundsProp(v: JsonValue | undefined): GeoBounds | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const [w, s, e, n] = v;
  if (typeof w !== 'number' || typeof s !== 'number' || typeof e !== 'number' || typeof n !== 'number') return undefined;
  const b = { west: w, south: s, east: e, north: n };
  return isValidBounds(b) ? b : undefined;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
