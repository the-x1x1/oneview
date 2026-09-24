import { ProviderError, type ProviderContext } from '@worldview/provider-sdk';
import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@worldview/connector-sdk';
import { fileSpecOf, hasGrantedFolder, ogr2ogrOf, type Ogr2ogrAccess, type Ogr2ogrDetection } from './contract.js';
import { checkRelativePath, extensionOf } from './path-policy.js';
import { FileBackedProvider, unsupportedSource, validateFileDefinition, type FileSource } from './provider.js';

/**
 * `gdal-import`: anything GDAL reads that WORLDVIEW does not read itself — a shapefile, a
 * GeoPackage, a File Geodatabase, FlatGeobuf, MapInfo, DXF, SpatiaLite, KMZ — converted to
 * GeoJSON by the operator's own `ogr2ogr` and then read exactly as a GeoJSON `local-file`.
 *
 * GDAL is never bundled, installed or downloaded: the host looks for `ogr2ogr` on PATH and
 * reports its version (amendment A3). Without it the source is OFFLINE with a message that
 * says so. The conversion reprojects to WGS 84 (`-t_srs EPSG:4326`, RFC 7946 output), runs
 * only when the dataset changed (the newest modification time over its files) and never
 * more often than the file interval.
 *
 * Only formats that hold their own data are accepted. A VRT, and formats like it, can point
 * at any other file or at a network location, which would read outside the granted folder;
 * they are refused by name, here and again by the host.
 */
export const GDAL_IMPORT_CONNECTOR_ID = 'gdal-import';

/** Extensions gdal-import converts: self-contained vector datasets (`gdb` is a folder). */
export const GDAL_INPUT_EXTENSIONS: readonly string[] = Object.freeze([
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

/** Extensions refused because the format can reference other files or URLs. */
export const GDAL_REFUSED_EXTENSIONS: readonly string[] = Object.freeze([
  'vrt',
  'xml',
  'gml',
  'ovf',
  'gfs',
  'xlsx',
  'ods',
]);

const READ_BY_LOCAL_FILE = new Set(['geojson', 'json', 'csv', 'tsv', 'txt', 'gpx', 'kml', 'topojson']);
const CONVERT_TIMEOUT_MS = 120_000;
/** How long an "ogr2ogr is not installed" answer is believed before looking again. */
export const REDETECT_AFTER_MS = 5 * 60_000;

export interface GdalImportProviderOptions {
  /** The converter; default: the host's (amendment A3). */
  converter?: (context: ProviderContext) => Ogr2ogrAccess | undefined;
}

export class GdalImportProvider extends FileBackedProvider {
  private detection: { at: number; result: Ogr2ogrDetection } | undefined;

  constructor(
    definition: ConnectorProviderDefinition,
    private readonly options: GdalImportProviderOptions = {},
  ) {
    super(definition, 'GDAL import', 'geojson', CONVERT_TIMEOUT_MS);
  }

  /** What detection last found (diagnostics, tests). */
  get detected(): Ogr2ogrDetection | undefined {
    return this.detection?.result;
  }

  protected createSource(context: ProviderContext): FileSource {
    const converter = this.options.converter ? this.options.converter(context) : hostConverter(context);
    if (!converter)
      return unsupportedSource(
        "this build cannot run ogr2ogr for a source yet (it needs the host's local-converter access)",
      );
    const layers = this.spec.layers ?? [];
    return {
      stat: async (signal) => {
        await this.ensureDetected(converter, signal);
        return converter.datasetStat(this.path);
      },
      load: async (maxBytes, signal) => {
        try {
          if (layers.length <= 1)
            return await converter.toGeoJson({
              input: this.path,
              ...(layers[0] ? { layer: layers[0] } : {}),
              timeoutMs: CONVERT_TIMEOUT_MS,
              maxOutputBytes: maxBytes,
              signal,
            });
          const parts: Array<{ layer: string; bytes: Uint8Array }> = [];
          let total = 0;
          for (const layer of layers) {
            const bytes = await converter.toGeoJson({
              input: this.path,
              layer,
              timeoutMs: CONVERT_TIMEOUT_MS,
              maxOutputBytes: maxBytes - total,
              signal,
            });
            total += bytes.length;
            parts.push({ layer, bytes });
          }
          return mergeLayers(parts);
        } catch (err) {
          // ogr2ogr uninstalled since it was found: look again on the next poll.
          if (err instanceof ProviderError && err.code === 'UNSUPPORTED') this.detection = undefined;
          throw err;
        }
      },
    };
  }

  private async ensureDetected(converter: Ogr2ogrAccess, signal: AbortSignal): Promise<void> {
    const now = this.context.clock.now();
    const known = this.detection;
    if (!known || (!known.result.found && now - known.at >= REDETECT_AFTER_MS)) {
      if (signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
      const result = await converter.detect();
      this.detection = { at: now, result };
      if (result.found && !known?.result.found)
        this.context.logger.info('ogr2ogr found', { version: result.version, dataset: this.path });
    }
    const current = this.detection!.result;
    if (!current.found)
      throw new ProviderError(
        'OFFLINE',
        `ogr2ogr was not found (${current.reason}); install GDAL to import ${this.path} — WORLDVIEW never installs or downloads it`,
        { retryable: true },
      );
  }
}

/**
 * Several layers' GeoJSON as one FeatureCollection. Each layer numbers its features from
 * zero, so ids are prefixed with the layer (`roads-12`) and each feature says which layer it
 * came from (`layer`, a member beside `properties`).
 */
export function mergeLayers(parts: Array<{ layer: string; bytes: Uint8Array }>): Uint8Array {
  const features: unknown[] = [];
  for (const { layer, bytes } of parts) {
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ProviderError('MALFORMED', `ogr2ogr wrote no valid GeoJSON for layer ${layer}`, { retryable: false });
    }
    const list = (doc as { features?: unknown } | null)?.features;
    if (!Array.isArray(list))
      throw new ProviderError('MALFORMED', `ogr2ogr wrote no FeatureCollection for layer ${layer}`, {
        retryable: false,
      });
    for (const f of list) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      const feature = f as Record<string, unknown>;
      const id = feature['id'];
      features.push({
        ...feature,
        ...(typeof id === 'string' || typeof id === 'number' ? { id: `${layer}-${id}` } : {}),
        layer,
      });
    }
  }
  return new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', features }));
}

function hostConverter(context: ProviderContext): Ogr2ogrAccess | undefined {
  return hasGrantedFolder(context.local) ? ogr2ogrOf(context.local) : undefined;
}

export function validateGdalImport(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const base = validateFileDefinition(d, 'gdal-import');
  const spec = fileSpecOf(d);
  if (!spec) return base;
  if (spec.format) base.errors.push('file.format is not used: gdal-import reads what GDAL reads (leave it out)');
  const path = checkRelativePath(spec.path);
  if (path.ok) {
    const ext = extensionOf(path.path);
    if (GDAL_REFUSED_EXTENSIONS.includes(ext))
      base.errors.push(
        `.${ext} is refused: the format can point at other files or network locations, outside the granted folder`,
      );
    else if (READ_BY_LOCAL_FILE.has(ext))
      base.errors.push(
        `.${ext} is read by the local-file connector directly; gdal-import is for the formats it does not read`,
      );
    else if (!GDAL_INPUT_EXTENSIONS.includes(ext))
      base.errors.push(
        `.${ext || '(no extension)'} is not a format gdal-import converts (${GDAL_INPUT_EXTENSIONS.join(', ')})`,
      );
  }
  if (d.response?.csv || d.response?.format)
    base.warnings.push('response.csv and response.format are ignored: GDAL writes GeoJSON');
  if (!d.mapping.observedAt)
    base.warnings.push(
      'mapping.observedAt is unset: records are dated by the dataset\'s modification time (flag "file-time")',
    );
  return { ...base, ok: base.errors.length === 0 };
}

export const gdalImportConnector: Connector = {
  metadata: {
    id: GDAL_IMPORT_CONNECTOR_ID,
    name: 'GDAL import',
    description:
      "A shapefile, GeoPackage, File Geodatabase or other vector dataset in a granted folder, converted by the operator's own ogr2ogr (never bundled or downloaded).",
    uses: ['mapping'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateGdalImport,
  createProvider: (d) => new GdalImportProvider(d),
};
