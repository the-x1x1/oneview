import { s, type Schema } from '@worldview/world-model';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import type { ProviderLocalAccess, ProviderManifest } from '@worldview/provider-sdk';

/**
 * The contracts the file connectors need from frozen packages, as this phase requests them
 * (docs/roadmap/phases/files.md, "Amendment requests"). Everything here is a shim: the
 * types and the schema fragment are exactly what the amendments would add, so the
 * connectors are written against the final shape and the integrator deletes this file when
 * the amendments land.
 *
 * - A1 (ADR-013, connector-sdk): a definition's `file` block. The definition schema drops
 *   keys it does not know, so without A1 a `file` block never reaches a connector.
 * - A2 (ADR-003, provider-sdk + runtime): a folder the operator names in a setting is the
 *   provider's grant (`grantedFolderSetting`), `statGrantedFile` for modification-time
 *   polling, and reads that resolve links before the containment check.
 * - A3 (ADR-003, provider-sdk + runtime): `ogr2ogr`, if the operator installed GDAL, run
 *   by the host with a closed argument list — never by the provider, never installed.
 */

// ── A1: the definition's `file` block ────────────────────────────────────────

export const FILE_FORMATS = ['geojson', 'csv', 'gpx', 'kml', 'topojson'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export interface FileSpec {
  /** The file inside the folder the operator granted, `/`-separated and relative (path-policy.ts). */
  path: string;
  /** What the file holds. Default: from the extension (`.json` is sniffed: a Topology or GeoJSON). */
  format?: FileFormat;
  /** How often the file's modification time is looked at. Default 30 s, never below 5 s. */
  intervalSeconds?: number;
  /** The largest file read; the host's own cap (32 MiB) still applies. Default 16 MiB. */
  maxBytes?: number;
  /** TopoJSON: the objects to read (default every object). gdal-import: the layers (default all). */
  layers?: string[];
}

export type FileConnectorDefinition = ConnectorProviderDefinition & { file?: FileSpec };

export const MIN_FILE_INTERVAL_SECONDS = 5;
export const DEFAULT_FILE_INTERVAL_SECONDS = 30;
export const DEFAULT_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** A layer or TopoJSON object name: no leading `-` (it would read as an ogr2ogr option), no quotes. */
export const LAYER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_. ()-]{0,127}$/;

export const fileSpecSchema: Schema<FileSpec> = s.object({
  path: s.string({ min: 1, max: 1024 }),
  format: s.optional(s.enum(FILE_FORMATS)),
  intervalSeconds: s.optional(s.number({ min: MIN_FILE_INTERVAL_SECONDS, max: 86_400 })),
  maxBytes: s.optional(s.number({ min: 1024, max: MAX_FILE_MAX_BYTES, integer: true })),
  layers: s.optional(s.array(s.string({ min: 1, max: 128, pattern: LAYER_NAME }), { min: 1, max: 16 })),
}) as Schema<FileSpec>;

/** The `file` block of a definition, when the schema kept it. */
export function fileSpecOf(d: ConnectorProviderDefinition): FileSpec | undefined {
  return (d as FileConnectorDefinition).file;
}

// ── A2: a granted folder the operator names ──────────────────────────────────

export interface GrantedFileStat {
  size: number;
  /** Milliseconds since the epoch. */
  mtimeMs: number;
}

/**
 * `ProviderLocalAccess` with A2. `readGrantedFile` and `statGrantedFile` resolve the file's
 * real path (following links and junctions) and refuse HOST_NOT_ALLOWED when it is not
 * inside the real path of the granted folder; a missing file or folder is UNSUPPORTED; a
 * folder where a file was named is UNSUPPORTED; over the cap is TOO_LARGE.
 */
export interface GrantedFolderAccess extends ProviderLocalAccess {
  statGrantedFile(path: string): Promise<GrantedFileStat>;
}

/** Whether this build's host gives the provider a folder of the operator's (A2). */
export function hasGrantedFolder(local: ProviderLocalAccess): local is GrantedFolderAccess {
  return typeof (local as Partial<GrantedFolderAccess>).statGrantedFile === 'function';
}

/** A2: the manifest names the setting whose value is the folder the host grants. */
export type FileSourceManifest = ProviderManifest & { grantedFolderSetting?: string };

// ── A3: GDAL's ogr2ogr, when the operator installed it ───────────────────────

export type Ogr2ogrDetection = { found: true; version: string } | { found: false; reason: string };

export interface Ogr2ogrRequest {
  /** The dataset inside the granted folder (a `.gdb` may be a folder). */
  input: string;
  /**
   * One layer. GDAL's GeoJSON writer holds a single layer, so a dataset with several is
   * converted one named layer at a time; with none named, ogr2ogr converts the only one.
   */
  layer?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * The host runs `ogr2ogr -f GeoJSON -t_srs EPSG:4326 -lco RFC7946=YES <out> <input> [layer]`
 * with no shell, a minimal environment and a fresh temporary directory, returns the output
 * file's bytes and deletes the directory. The provider chooses only the input (inside the
 * grant, under the same checks as A2) and the layer name. Errors: UNSUPPORTED (not
 * installed, or an input format that can point elsewhere, such as VRT), HOST_NOT_ALLOWED
 * (outside the grant), TIMEOUT, TOO_LARGE, CANCELLED, MALFORMED (a non-zero exit, with the
 * last line GDAL printed).
 */
export interface Ogr2ogrAccess {
  detect(): Promise<Ogr2ogrDetection>;
  /**
   * Size and newest modification time over the files that make up a dataset — a
   * shapefile's `.shp` with its `.dbf`, `.shx`, `.prj` and `.cpg`, or the files directly
   * inside a `.gdb` folder — so an edit to any of them is seen. Same path checks as A2.
   */
  datasetStat(input: string): Promise<GrantedFileStat>;
  toGeoJson(request: Ogr2ogrRequest): Promise<Uint8Array>;
}

export function ogr2ogrOf(local: ProviderLocalAccess): Ogr2ogrAccess | undefined {
  const tool = (local as { ogr2ogr?: Ogr2ogrAccess }).ogr2ogr;
  return tool &&
    typeof tool.detect === 'function' &&
    typeof tool.datasetStat === 'function' &&
    typeof tool.toGeoJson === 'function'
    ? tool
    : undefined;
}
