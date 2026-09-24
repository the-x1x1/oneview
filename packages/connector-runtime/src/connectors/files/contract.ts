import type { ProviderLocalAccess, ProviderManifest, Ogr2ogrAccess } from '@worldview/provider-sdk';
import type { ConnectorProviderDefinition, FileSpec } from '@worldview/connector-sdk';

/**
 * The contracts the file connectors use, as the SDKs now hold them (ADR-003 and ADR-013
 * amendments of 2026-09-23, landed with phase `files`): the definition's `file` block and
 * its schema live in `@worldview/connector-sdk`; the granted folder, its path rule and
 * `ogr2ogr` in `@worldview/provider-sdk`. What remains here is the connectors' own view of
 * a host: whether this one grants a folder, and whether it converts.
 */
export {
  DEFAULT_FILE_INTERVAL_SECONDS,
  DEFAULT_FILE_MAX_BYTES,
  FILE_FORMATS,
  LAYER_NAME,
  MAX_FILE_MAX_BYTES,
  MIN_FILE_INTERVAL_SECONDS,
  fileSpecSchema,
  type FileFormat,
  type FileSpec,
} from '@worldview/connector-sdk';
export type { GrantedFileStat, Ogr2ogrAccess, Ogr2ogrDetection, Ogr2ogrRequest } from '@worldview/provider-sdk';

/** A definition that reads a file: the same type, named for the connectors that need the block. */
export type FileConnectorDefinition = ConnectorProviderDefinition & { file?: FileSpec };

/** The `file` block of a definition. */
export function fileSpecOf(d: ConnectorProviderDefinition): FileSpec | undefined {
  return d.file;
}

/** A host that grants a folder: `statGrantedFile` is present (a host without it refuses with UNSUPPORTED). */
export interface GrantedFolderAccess extends ProviderLocalAccess {
  statGrantedFile(path: string): Promise<{ size: number; mtimeMs: number }>;
}

/** Whether this build's host gives the provider a folder of the user's. */
export function hasGrantedFolder(local: ProviderLocalAccess): local is GrantedFolderAccess {
  return typeof (local as Partial<GrantedFolderAccess>).statGrantedFile === 'function';
}

/** The manifest of a file source: a `ProviderManifest` whose `grantedFolderSetting` names the folder setting. */
export type FileSourceManifest = ProviderManifest & { grantedFolderSetting?: string };

/** The host's ogr2ogr, when it offers one (only providers with a granted folder get it). */
export function ogr2ogrOf(local: ProviderLocalAccess): Ogr2ogrAccess | undefined {
  const tool = local.ogr2ogr;
  return tool &&
    typeof tool.detect === 'function' &&
    typeof tool.datasetStat === 'function' &&
    typeof tool.toGeoJson === 'function'
    ? tool
    : undefined;
}
