/**
 * The reference layer: faint country and state borders and their names, drawn by both
 * renderers under the world's own objects (ADR-008 amendment, 2026-09-23).
 *
 * The data is bundled — Natural Earth, public domain — and built by
 * tools/dev/reference-data/build.mjs into two compact documents, decoded here once and
 * handed to whichever renderer is active. Nothing is fetched from the network: borders and
 * names are there offline and on every basemap, including none.
 *
 * Zoom thresholds are Natural Earth's own (`MIN_ZOOM`, `MIN_LABEL`, `MAX_LABEL`), which are
 * in the same 256-px web-zoom convention as `ViewState.zoom`.
 */

export const REFERENCE_BORDERS_FORMAT = 'worldview-reference-borders@1';
export const REFERENCE_LABELS_FORMAT = 'worldview-reference-labels@1';
export const REFERENCE_ATTRIBUTION = 'Borders and names: Made with Natural Earth';

export type ReferenceKind = 'country' | 'state';

export interface ReferenceLine {
  kind: ReferenceKind;
  /** Disputed, indefinite, line of control or unrecognised: drawn dashed. */
  dashed: boolean;
  minZoom: number;
  /** `[lon, lat, lon, lat, …]`, degrees. */
  coords: Float64Array;
  /** `[west, south, east, north]`. */
  bbox: [number, number, number, number];
}

export interface ReferenceLabel {
  kind: ReferenceKind;
  name: string;
  lon: number;
  lat: number;
  minZoom: number;
  maxZoom: number;
  /** Natural Earth label rank: lower is more important. */
  rank: number;
  /** ISO 3166 alpha-3 of the country a state belongs to. */
  country?: string;
}

export interface ReferenceData {
  lines: ReferenceLine[];
  labels: ReferenceLabel[];
  attribution: string;
}

/** What the operator has switched on (Settings → Map). */
export interface ReferenceOptions {
  borders: boolean;
  labels: boolean;
}

export const REFERENCE_OFF: ReferenceOptions = { borders: false, labels: false };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Decode the borders document. Throws on a document of another format; a malformed row
 * is skipped rather than failing the whole layer.
 */
export function decodeReferenceBorders(doc: unknown): ReferenceLine[] {
  if (!isObject(doc) || doc['format'] !== REFERENCE_BORDERS_FORMAT)
    throw new Error(`not a ${REFERENCE_BORDERS_FORMAT} document`);
  const q = typeof doc['quantisation'] === 'number' && doc['quantisation'] > 0 ? doc['quantisation'] : 0.001;
  const out: ReferenceLine[] = [];
  const decode = (rows: unknown, kind: ReferenceKind) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6 || row.length % 2 !== 0) continue;
      const [z, flags] = row as number[];
      if (typeof z !== 'number' || typeof flags !== 'number') continue;
      const n = (row.length - 2) / 2;
      const coords = new Float64Array(n * 2);
      let x = 0;
      let y = 0;
      let w = Infinity,
        s = Infinity,
        e = -Infinity,
        nn = -Infinity;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const dx = row[2 + i * 2];
        const dy = row[3 + i * 2];
        if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) {
          ok = false;
          break;
        }
        x = i === 0 ? dx : x + dx;
        y = i === 0 ? dy : y + dy;
        const lon = x * q;
        const lat = y * q;
        coords[i * 2] = lon;
        coords[i * 2 + 1] = lat;
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > nn) nn = lat;
      }
      if (!ok || w < -180.001 || e > 180.001 || s < -90.001 || nn > 90.001) continue;
      out.push({ kind, dashed: (flags & 1) === 1, minZoom: z, coords, bbox: [w, s, e, nn] });
    }
  };
  decode(doc['countries'], 'country');
  decode(doc['states'], 'state');
  return out;
}

export function decodeReferenceLabels(doc: unknown): ReferenceLabel[] {
  if (!isObject(doc) || doc['format'] !== REFERENCE_LABELS_FORMAT)
    throw new Error(`not a ${REFERENCE_LABELS_FORMAT} document`);
  const out: ReferenceLabel[] = [];
  const decode = (rows: unknown, kind: ReferenceKind) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const [name, lon, lat, minZoom, maxZoom, rank, country] = row as unknown[];
      if (
        typeof name !== 'string' ||
        !name ||
        typeof lon !== 'number' ||
        typeof lat !== 'number' ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90 ||
        typeof minZoom !== 'number' ||
        typeof maxZoom !== 'number'
      )
        continue;
      const label: ReferenceLabel = {
        kind,
        name: name.slice(0, 80),
        lon,
        lat,
        minZoom,
        maxZoom,
        rank: typeof rank === 'number' ? rank : 9,
      };
      if (typeof country === 'string' && country) label.country = country;
      out.push(label);
    }
  };
  decode(doc['countries'], 'country');
  decode(doc['states'], 'state');
  return out;
}

/** Whether a line is drawn at `zoom`. */
export function lineVisibleAt(line: Pick<ReferenceLine, 'minZoom'>, zoom: number): boolean {
  return zoom >= line.minZoom;
}

/**
 * Whether a label is shown at `zoom`. A country name stays up to its `maxZoom`; past it the
 * map is showing streets, and the name of the country being looked at is not information.
 */
export function labelVisibleAt(label: Pick<ReferenceLabel, 'minZoom' | 'maxZoom'>, zoom: number): boolean {
  return zoom >= label.minZoom && zoom <= label.maxZoom;
}

/** Border lines as GeoJSON for a 2D renderer: one LineString per line, `kind`, `minZoom`, `dashed`. */
export function referenceLinesGeoJSON(lines: readonly ReferenceLine[], kind?: ReferenceKind) {
  return {
    type: 'FeatureCollection' as const,
    features: lines
      .filter((l) => !kind || l.kind === kind)
      .map((l) => {
        const coordinates: number[][] = [];
        for (let i = 0; i < l.coords.length; i += 2) coordinates.push([l.coords[i]!, l.coords[i + 1]!]);
        return {
          type: 'Feature' as const,
          properties: { kind: l.kind, minZoom: l.minZoom, dashed: l.dashed },
          geometry: { type: 'LineString' as const, coordinates },
        };
      }),
  };
}

/** Labels as GeoJSON points: `name`, `kind`, `minZoom`, `maxZoom`, `rank`. */
export function referenceLabelsGeoJSON(labels: readonly ReferenceLabel[]) {
  return {
    type: 'FeatureCollection' as const,
    features: labels.map((l) => ({
      type: 'Feature' as const,
      properties: { name: l.name, kind: l.kind, minZoom: l.minZoom, maxZoom: l.maxZoom, rank: l.rank },
      geometry: { type: 'Point' as const, coordinates: [l.lon, l.lat] },
    })),
  };
}
