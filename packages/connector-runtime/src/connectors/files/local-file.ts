import type { ProviderContext } from '@worldview/provider-sdk';
import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@worldview/connector-sdk';
import { fileSpecOf, hasGrantedFolder, type FileFormat } from './contract.js';
import { checkRelativePath } from './path-policy.js';
import { formatOf } from './formats.js';
import {
  FileBackedProvider,
  FOLDER_SETTING,
  unsupportedSource,
  validateFileDefinition,
  type FileSource,
} from './provider.js';

/**
 * `local-file`: a file in a folder the operator granted is a source. GeoJSON, CSV, GPX, KML
 * and TopoJSON; the file's modification time is looked at on every poll (every 30 s by
 * default, never more often than every 5 s) and the file is read and mapped only when it
 * changed. The definition names the file relative to the folder; the folder itself is the
 * operator's, named in the source's `folder` setting and granted by the host (amendment A2).
 */
export const LOCAL_FILE_CONNECTOR_ID = 'local-file';
const READ_TIMEOUT_MS = 20_000;

/** The host's granted folder as a file source, or a clear refusal where this build has none. */
export function grantedFolderSource(context: ProviderContext, path: string): FileSource {
  const local = context.local;
  if (!hasGrantedFolder(local))
    return unsupportedSource(
      `this build cannot grant a folder to a file source yet (it needs the host's granted-folder access); set the "${FOLDER_SETTING}" setting once it can`,
    );
  return {
    stat: () => local.statGrantedFile(path),
    load: (maxBytes) => local.readGrantedFile(path, { maxBytes }),
  };
}

export interface LocalFileProviderOptions {
  /** The port the file is read through. Default: the host's granted folder. */
  source?: (context: ProviderContext, path: string) => FileSource;
}

export class LocalFileProvider extends FileBackedProvider {
  constructor(
    definition: ConnectorProviderDefinition,
    private readonly options: LocalFileProviderOptions = {},
  ) {
    super(definition, 'Local file', resolveFormat(definition), READ_TIMEOUT_MS);
  }

  protected createSource(context: ProviderContext): FileSource {
    return (this.options.source ?? grantedFolderSource)(context, this.path);
  }
}

function resolveFormat(d: ConnectorProviderDefinition): FileFormat | 'json' {
  const spec = fileSpecOf(d);
  const path = spec ? checkRelativePath(spec.path) : undefined;
  const format = spec && path?.ok ? formatOf(spec, path.path) : undefined;
  if (!format) throw new Error(`${d.id}: the format of the file cannot be told from its name; set file.format`);
  return format;
}

export function validateLocalFile(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const base = validateFileDefinition(d, 'local-file');
  const spec = fileSpecOf(d);
  if (!spec) return base;
  const path = checkRelativePath(spec.path);
  const format = path.ok ? formatOf(spec, path.path) : undefined;
  if (path.ok && !format)
    base.errors.push(
      `file.format is needed: "${path.path}" does not end in .geojson, .json, .csv, .tsv, .txt, .gpx, .kml or .topojson`,
    );
  if (format === 'csv') {
    if (!d.mapping.position && !d.mapping.geometry)
      base.errors.push(
        'a CSV file needs mapping.position (its latitude and longitude columns); an address column is never geocoded',
      );
    if (d.response?.csv?.header === false && !d.response.csv.columns?.length)
      base.errors.push('response.csv.header is false but no columns are named');
  } else if (d.response?.csv) base.warnings.push('response.csv is ignored: the file is not CSV');
  if (d.response?.format) base.warnings.push('response.format is ignored: file.format (or the extension) decides');
  if (spec.layers?.length && format !== 'topojson' && format !== 'json')
    base.warnings.push('file.layers is read only for TopoJSON (and by gdal-import)');
  if (format && format !== 'gpx' && format !== 'kml' && !d.mapping.observedAt)
    base.warnings.push(
      'mapping.observedAt is unset: records are dated by the file\'s modification time (flag "file-time")',
    );
  if (d.response?.itemsPath && format !== 'geojson' && format !== 'json')
    base.warnings.push('response.itemsPath is read only for GeoJSON');
  return { ...base, ok: base.errors.length === 0 };
}

export const localFileConnector: Connector = {
  metadata: {
    id: LOCAL_FILE_CONNECTOR_ID,
    name: 'Local file',
    description:
      'A GeoJSON, CSV, GPX, KML or TopoJSON file in a folder the operator granted; re-read when its modification time changes.',
    uses: ['response', 'mapping'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateLocalFile,
  createProvider: (d) => new LocalFileProvider(d),
};
