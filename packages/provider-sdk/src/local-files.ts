/**
 * Files in a folder the user granted (ADR-003, amendments 2026-09-23 for phase `files`).
 *
 * A provider names a file relative to the granted folder; the host resolves it against the
 * folder's real path (links and junctions followed) and refuses anything outside. The path
 * rule below is the provider's half of that check, so a bad path is refused when a
 * definition is validated and again before every read; the host makes the final one against
 * the real file system. Both halves refuse a path outside the folder whichever side is wrong.
 *
 * Refused: absolute paths (`/x`, `\x`), drive letters (`C:`), UNC and device paths
 * (`\\server\share`, `//server`, `\\?\`, `\\.\`), any `:` (URL schemes, Windows alternate
 * data streams), `..`, empty segments, NUL and control characters, the characters Windows
 * forbids in names (`<>"|?*`), segments ending in a dot or a space (Windows strips them, so
 * two names would reach one file), and the reserved device names (`CON`, `NUL`, `COM1`…).
 */
export const MAX_FILE_PATH_LENGTH = 1024;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const FORBIDDEN = /[<>"|?*]/;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export type PathVerdict = { ok: true; path: string; segments: string[] } | { ok: false; reason: string };

/** Whether a path may name a file inside a granted folder; on success, the normalised `/`-joined path and its segments. */
export function checkRelativePath(input: unknown): PathVerdict {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, reason: 'the file path is empty' };
  if (input.length > MAX_FILE_PATH_LENGTH)
    return { ok: false, reason: `the file path is longer than ${MAX_FILE_PATH_LENGTH} characters` };
  if (hasControlCharacter(input)) return { ok: false, reason: 'the file path contains a control character' };
  if (/^[\\/]{2}/.test(input))
    return { ok: false, reason: 'the file path is a UNC or device path; name a file inside the granted folder' };
  if (/^[\\/]/.test(input))
    return { ok: false, reason: 'the file path is absolute; name it relative to the granted folder' };
  if (/^[A-Za-z]:/.test(input))
    return { ok: false, reason: 'the file path names a drive; name it relative to the granted folder' };
  if (input.includes(':')) return { ok: false, reason: 'the file path contains ":" (a URL, a drive or a stream)' };
  if (FORBIDDEN.test(input))
    return { ok: false, reason: 'the file path contains a character Windows forbids (<>"|?*)' };
  const segments = input.split(/[\\/]/);
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === '') return { ok: false, reason: 'the file path has an empty segment' };
    if (segment === '.') continue;
    if (segment === '..') return { ok: false, reason: 'the file path climbs out of the granted folder ("..")' };
    if (segment === '~') return { ok: false, reason: 'the file path starts from a home folder ("~")' };
    if (/[. ]$/.test(segment))
      return { ok: false, reason: `the segment "${segment}" ends in a dot or a space, which Windows removes` };
    if (WINDOWS_RESERVED.test(segment))
      return { ok: false, reason: `"${segment}" is a device name on Windows, not a file` };
    kept.push(segment);
  }
  if (kept.length === 0) return { ok: false, reason: 'the file path names the folder itself, not a file' };
  return { ok: true, path: kept.join('/'), segments: kept };
}

/** The extension of a checked path, lower-case, without the dot (`''` when there is none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export interface GrantedFileStat {
  size: number;
  /** Milliseconds since the epoch. */
  mtimeMs: number;
}

// ── ogr2ogr, when the user installed GDAL ────────────────────────────────────

/**
 * Extensions the host converts with ogr2ogr: self-contained vector datasets (`gdb` is a
 * folder). Formats that can reference other files or URLs (VRT, GML with a schema, OVF, …)
 * are not on the list and are refused by name — by the connector and again by the host.
 */
export const OGR_INPUT_EXTENSIONS: readonly string[] = Object.freeze([
  'shp',
  'gpkg',
  'gdb',
  'fgb',
  'tab',
  'mif',
  'dxf',
  'sqlite',
  'kmz',
  'geojsonl',
  'geojsons',
]);

/** A layer (or TopoJSON object) name: no leading `-` (it would read as an ogr2ogr option), no quotes. */
export const OGR_LAYER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_. ()-]{0,127}$/;

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
 * grant, under the same checks as a granted file) and the layer name. Errors: UNSUPPORTED
 * (not installed, or an input format that can point elsewhere, such as VRT), HOST_NOT_ALLOWED
 * (outside the grant), TIMEOUT, TOO_LARGE, CANCELLED, MALFORMED (a non-zero exit, with the
 * last line GDAL printed). Offered only to providers that declare a `grantedFolderSetting`.
 */
export interface Ogr2ogrAccess {
  detect(): Promise<Ogr2ogrDetection>;
  /**
   * Size and newest modification time over the files that make up a dataset — a
   * shapefile's `.shp` with its `.dbf`, `.shx`, `.prj` and `.cpg`, or the files directly
   * inside a `.gdb` folder — so an edit to any of them is seen. Same path checks as a read.
   */
  datasetStat(input: string): Promise<GrantedFileStat>;
  toGeoJson(request: Ogr2ogrRequest): Promise<Uint8Array>;
}
