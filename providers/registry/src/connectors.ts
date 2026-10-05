import type { WorldProvider } from '@worldview/provider-sdk';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import {
  defaultConnectorRegistry,
  listDefinitionFiles,
  loadDefinitionsFrom,
  type LoadedDefinitions,
} from '@worldview/connector-runtime';
import type { ProviderFactory } from './index.js';

/**
 * Providers configured as data (ADR-013): definitions the runtime loads from its bundled
 * `connectors/` directory (reviewed, may open policy fields) and from the operator's own
 * `connectors/` folder in the data directory (user-configured: policy fails closed, and a
 * file cannot declare itself reviewed). Each definition becomes a factory keyed by its id,
 * beside the hand-written providers; an id already taken by one of those is refused.
 */
export function connectorProviderFactories(
  definitions: readonly ConnectorProviderDefinition[],
): Record<string, ProviderFactory> {
  const out: Record<string, ProviderFactory> = {};
  for (const d of definitions) out[d.id] = () => defaultConnectorRegistry.createProvider(d);
  return out;
}

export interface ConnectorDirectories {
  /** Definitions shipped with the app (`connectors/enabled` under the resources directory). */
  bundledDir?: string;
  /** The operator's own definitions (`connectors` under the data directory). */
  userDir?: string;
  /**
   * Definition sets carried by installed world packs (OFFLINE-PACKS.md §4b). A set is
   * loaded only when `trusted` (the pack is signed by one of the operator's publishers), and
   * then as user-configured: policy fails closed as for the operator's own files. An
   * untrusted set's files are listed as refused, with the reason.
   */
  packSets?: ReadonlyArray<{ packId: string; dir: string; trusted: boolean }>;
}

/** How a pack's definition file is named in the listing: `pack/<pack id>/<file>`. */
export function packDefinitionFile(packId: string, file: string): string {
  return `pack/${packId}/${file}`;
}

export const UNTRUSTED_PACK_DEFINITION =
  'the pack is not signed by one of your publishers, so its definitions are not loaded (Settings → Offline packs → Trust this publisher)';

/** Load both directories; problems are returned for the log, never thrown. */
export function loadConnectorDefinitions(dirs: ConnectorDirectories, reservedIds: Iterable<string>): LoadedDefinitions {
  const reserved = new Set(reservedIds);
  const out: LoadedDefinitions = { definitions: [], problems: [], warnings: [], files: [] };
  if (dirs.bundledDir) {
    const bundled = loadDefinitionsFrom(dirs.bundledDir, { reservedIds: reserved });
    for (const d of bundled.definitions) reserved.add(d.id);
    out.definitions.push(...bundled.definitions);
    out.problems.push(...bundled.problems.map((p) => ({ ...p, file: `bundled/${p.file}` })));
    out.warnings.push(...bundled.warnings.map((w) => ({ ...w, file: `bundled/${w.file}` })));
    out.files.push(...bundled.files.map((f) => ({ ...f, file: `bundled/${f.file}` })));
  }
  for (const set of dirs.packSets ?? []) {
    const name = (f: string) => packDefinitionFile(set.packId, f);
    if (!set.trusted) {
      for (const f of listDefinitionFiles(set.dir)) {
        out.problems.push({ file: name(f), errors: [UNTRUSTED_PACK_DEFINITION] });
        out.files.push({ file: name(f), problems: [UNTRUSTED_PACK_DEFINITION], warnings: [] });
      }
      continue;
    }
    const pack = loadDefinitionsFrom(set.dir, { reservedIds: reserved, review: 'user-configured' });
    for (const d of pack.definitions) reserved.add(d.id);
    // A pack's source starts switched off whatever its file says: the operator turns it on.
    out.definitions.push(...pack.definitions.map((d) => ({ ...d, enabled: false })));
    out.problems.push(...pack.problems.map((p) => ({ ...p, file: name(p.file) })));
    out.warnings.push(...pack.warnings.map((w) => ({ ...w, file: name(w.file) })));
    out.files.push(...pack.files.map((f) => ({ ...f, file: name(f.file) })));
  }
  if (dirs.userDir) {
    const user = loadDefinitionsFrom(dirs.userDir, { reservedIds: reserved, review: 'user-configured' });
    out.definitions.push(...user.definitions);
    out.problems.push(...user.problems);
    out.warnings.push(...user.warnings);
    out.files.push(...user.files);
  }
  return out;
}

export { defaultConnectorRegistry };
export { draftDefinition, type DraftResult, type DefinitionFile } from '@worldview/connector-runtime';
export { checkUrl as checkDefinitionUrl, type ConnectorProviderDefinition } from '@worldview/connector-sdk';
export type { WorldProvider };
