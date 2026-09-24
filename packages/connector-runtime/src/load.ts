import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { ConnectorRegistry, defaultConnectorRegistry } from './registry.js';

/**
 * Definitions from a directory of `*.json` documents. A file that does not validate is
 * reported, not thrown: one bad definition must never keep the others (or the app) from
 * starting. `review` is forced for the operator's own folder — a user-configured file cannot
 * declare itself reviewed.
 */
export interface LoadedDefinitions {
  definitions: ConnectorProviderDefinition[];
  problems: Array<{ file: string; errors: string[] }>;
  warnings: Array<{ file: string; warnings: string[] }>;
}

export interface LoadOptions {
  registry?: ConnectorRegistry;
  /** Force this review level on every definition in the directory. */
  review?: ConnectorProviderDefinition['review'];
  /** Ids already taken (bundled providers); a definition reusing one is a problem. */
  reservedIds?: Iterable<string>;
}

export const MAX_DEFINITION_BYTES = 256 * 1024;

export function loadDefinitionsFrom(dir: string, opts: LoadOptions = {}): LoadedDefinitions {
  const registry = opts.registry ?? defaultConnectorRegistry;
  const out: LoadedDefinitions = { definitions: [], problems: [], warnings: [] };
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
  } catch {
    return out;
  }
  const taken = new Set(opts.reservedIds ?? []);
  for (const file of files) {
    const abs = path.join(dir, file);
    let doc: unknown;
    try {
      if (statSync(abs).size > MAX_DEFINITION_BYTES) {
        out.problems.push({ file, errors: [`larger than ${MAX_DEFINITION_BYTES} bytes`] });
        continue;
      }
      doc = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      out.problems.push({ file, errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] });
      continue;
    }
    if (opts.review && doc && typeof doc === 'object' && !Array.isArray(doc))
      (doc as Record<string, unknown>)['review'] = opts.review;
    const r = registry.validate(doc);
    if (!r.ok || !r.definition) {
      out.problems.push({ file, errors: r.errors });
      continue;
    }
    if (taken.has(r.definition.id)) {
      out.problems.push({ file, errors: [`id "${r.definition.id}" is already used by another provider`] });
      continue;
    }
    taken.add(r.definition.id);
    if (r.warnings.length) out.warnings.push({ file, warnings: r.warnings });
    out.definitions.push(r.definition);
  }
  return out;
}
