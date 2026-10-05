import type { ConnectorProviderDefinition, MappingSpec } from '@worldview/connector-sdk';
import { extractRecords } from '@worldview/connector-sdk';
import { parseCsv } from '../../csv.js';
import { FILE_FORMATS, type FileFormat, type FileSpec } from './contract.js';
import { extensionOf } from './path-policy.js';
import { readGpx } from './gpx.js';
import { readKml } from './kml.js';
import { readTopologyDocument } from './topojson.js';
import { declaredEncoding } from './xml.js';

/**
 * From a file's bytes to records the mapping reads: the text decoded, the format chosen, the
 * reader for it run. GeoJSON and CSV are read exactly as the `geojson` and `csv` connectors
 * read a body (the same CSV reader, the same record extraction); GPX, KML and TopoJSON become
 * GeoJSON-shaped features (features.ts).
 */
const BY_EXTENSION: Readonly<Record<string, FileFormat | 'json'>> = Object.freeze({
  geojson: 'geojson',
  json: 'json',
  csv: 'csv',
  tsv: 'csv',
  txt: 'csv',
  gpx: 'gpx',
  kml: 'kml',
  topojson: 'topojson',
});

/** The format a spec names or its extension implies; `json` is decided by the content. */
export function formatOf(spec: FileSpec, path: string): FileFormat | 'json' | undefined {
  return spec.format ?? BY_EXTENSION[extensionOf(path)];
}

export function isFileFormat(v: unknown): v is FileFormat {
  return typeof v === 'string' && (FILE_FORMATS as readonly string[]).includes(v);
}

export interface DecodedText {
  text: string;
  encoding: string;
  /** The bytes were not UTF-8 and were read as Windows-1252 instead. */
  fallback?: boolean;
}

/**
 * Bytes to text: a byte-order mark decides (UTF-8, UTF-16 LE/BE); then an XML declaration's
 * encoding, for GPX and KML; then UTF-8, strictly. A file that is not valid UTF-8 and names
 * no encoding is read as Windows-1252 — what spreadsheet programs on Windows write — and the
 * provider says so in its log, rather than turning every accented name into U+FFFD.
 */
export function decodeText(bytes: Uint8Array, xml: boolean): DecodedText {
  const [a, b, c] = [bytes[0], bytes[1], bytes[2]];
  if (a === 0xef && b === 0xbb && c === 0xbf) return { text: decode('utf-8', bytes.subarray(3)), encoding: 'utf-8' };
  if (a === 0xff && b === 0xfe) return { text: decode('utf-16le', bytes.subarray(2)), encoding: 'utf-16le' };
  if (a === 0xfe && b === 0xff) return { text: decode('utf-16be', bytes.subarray(2)), encoding: 'utf-16be' };
  if (xml) {
    const head = decode('latin1', bytes.subarray(0, 256));
    const declared = declaredEncoding(head);
    if (declared && declared !== 'utf-8' && declared !== 'utf8') {
      try {
        const decoder = new TextDecoder(declared);
        // Every Latin-1 label is Windows-1252 to the Encoding Standard; read by the table below.
        const text = decoder.encoding === 'windows-1252' ? decodeWindows1252(bytes) : decoder.decode(bytes);
        return { text, encoding: declared };
      } catch {
        /* an encoding TextDecoder does not know: fall through to UTF-8, which most such files really are */
      }
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', fallback: true };
  }
}

/**
 * What Windows-1252 puts at 0x80–0x9F (the Encoding Standard's table; the five bytes it leaves
 * unassigned stay the C1 control of the same number). Everything else is Latin-1, byte for
 * code point.
 */
const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * Windows-1252 by the table, not by `TextDecoder`: Node 22.22's decoder (and other builds with
 * its Latin-1 fast path) reads this encoding as plain Latin-1, so € (0x80), the curly quotes
 * and the dashes a spreadsheet writes came out as invisible C1 controls.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let out = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const slice = bytes.subarray(start, Math.min(bytes.length, start + CHUNK));
    const codes = new Uint16Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i]!;
      codes[i] = b >= 0x80 && b < 0xa0 ? WINDOWS_1252_HIGH[b - 0x80]! : b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

function decode(encoding: string, bytes: Uint8Array): string {
  return new TextDecoder(encoding).decode(bytes);
}

export interface FileRecords {
  records: unknown[];
  /** The format actually read (a `.json` file resolved to `geojson` or `topojson`). */
  format: FileFormat;
  /** Elements the reader could not turn into records, with reasons (counted as rejected). */
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
}

/** The records in a file's text, or why there are none. */
export function readFileRecords(
  text: string,
  format: FileFormat | 'json',
  definition: ConnectorProviderDefinition,
  spec: FileSpec,
): FileRecords | { malformed: string } {
  const layers = spec.layers ? { layers: spec.layers } : {};
  if (format === 'gpx' || format === 'kml') {
    const r = format === 'gpx' ? readGpx(text) : readKml(text);
    if ('malformed' in r) return r;
    return { records: r.features, format, skipped: r.skipped, notes: r.notes };
  }
  if (format === 'csv') {
    const csv = parseCsv(text, { ...(definition.response?.csv ?? {}) });
    if (csv.malformed) return { malformed: `not CSV (${csv.malformed})` };
    const notes = csv.dropped ? [`${csv.dropped} row(s) past the row limit were dropped`] : [];
    return { records: csv.records, format, skipped: [], notes };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { malformed: 'the file is not valid JSON' };
  }
  const type = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as { type?: unknown }).type : undefined;
  if (format === 'topojson' || (format === 'json' && type === 'Topology')) {
    const r = readTopologyDocument(doc, layers);
    if ('malformed' in r) return r;
    return { records: r.features, format: 'topojson', skipped: r.skipped, notes: r.notes };
  }
  return readGeoJson(doc, type, definition);
}

function readGeoJson(
  doc: unknown,
  type: unknown,
  definition: ConnectorProviderDefinition,
): FileRecords | { malformed: string } {
  const crs = crsName(doc);
  if (crs && !/(CRS84|EPSG:+4326)\b/i.test(crs))
    return {
      malformed: `the file declares the coordinate system ${crs.slice(0, 80)}; GeoJSON here must be longitude/latitude (WGS 84) — convert it, or read it with gdal-import, which reprojects`,
    };
  if (definition.response?.itemsPath) {
    const found = extractRecords(doc, definition.response);
    if ('malformed' in found) return { malformed: found.malformed };
    return { records: found.records, format: 'geojson', skipped: [], notes: [] };
  }
  if (type === 'FeatureCollection') {
    const features = (doc as { features?: unknown }).features;
    if (!Array.isArray(features)) return { malformed: 'not GeoJSON: a FeatureCollection without a features array' };
    return { records: features, format: 'geojson', skipped: [], notes: [] };
  }
  if (type === 'Feature') return { records: [doc], format: 'geojson', skipped: [], notes: [] };
  return { malformed: 'not GeoJSON: expected a FeatureCollection or a Feature' };
}

/** The pre-RFC 7946 `crs` member's name, when a file still carries one. */
function crsName(doc: unknown): string | undefined {
  const crs = (doc as { crs?: { properties?: { name?: unknown } } } | null)?.crs;
  const name = crs?.properties?.name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The definition with the file format's defaults filled in where it left them out:
 * geometry-bearing formats take their position from `point` (a track's last fix), falling
 * back to the geometry's first coordinate, and keep the geometry itself — but only when the
 * definition names neither, as the `geojson` connector does. GPX and KML also date records
 * by their `time` and label them by `name` unless the definition says otherwise. CSV has no
 * defaults: its columns are the definition's to name.
 */
export function withFileDefaults(
  d: ConnectorProviderDefinition,
  format: FileFormat | 'json',
): ConnectorProviderDefinition {
  if (format === 'csv') return d;
  const mapping: MappingSpec = { ...d.mapping };
  if (!mapping.position && !mapping.geometry) {
    mapping.position = { geometry: { path: 'point', fallback: 'geometry' } };
    mapping.geometry = 'geometry';
  }
  if (format === 'gpx' || format === 'kml') {
    if (!mapping.observedAt) mapping.observedAt = 'time';
    if (!mapping.labels) mapping.labels = { name: 'name' };
    if (!mapping.properties)
      mapping.properties =
        format === 'gpx'
          ? {
              kind: 'kind',
              description: 'description',
              pointCount: 'properties.pointCount',
              lengthM: 'properties.lengthM',
              startTime: 'properties.startTime',
              endTime: 'properties.endTime',
              ele: 'properties.ele',
            }
          : { kind: 'kind', description: 'description', folder: 'properties.folder', address: 'properties.address' };
  }
  return { ...d, mapping };
}
