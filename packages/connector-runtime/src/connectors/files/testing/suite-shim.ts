import type { ProviderContext, WorldProvider } from '@worldview/provider-sdk';
import {
  parseDefinition,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import { ConnectorRegistry } from '../../../registry.js';
import { fileSpecSchema, type FileConnectorDefinition, type Ogr2ogrAccess } from '../contract.js';
import type { FileSource } from '../provider.js';
import { LOCAL_FILE_CONNECTOR_ID, LocalFileProvider } from '../local-file.js';
import { GDAL_IMPORT_CONNECTOR_ID, GdalImportProvider } from '../gdal-import.js';

/**
 * How the shared connector suite runs a file definition before amendments A1 and A4 land.
 *
 * A1 — the definition schema keeps the `file` block: `validate` parses the document with the
 * frozen schema, then validates `file` with the schema fragment A1 adds (contract.ts) and
 * puts it back, exactly as the amended `parseDefinition` would.
 *
 * A4 — the suite serves its fixture as the file: the frozen suite feeds a fixture only as
 * an HTTP response, so `createProvider` gives a file provider a port that asks the suite's
 * fixture responder for the file's bytes. What the suite checks then holds for the file
 * path: the fixture is parsed and mapped by the real provider; an empty or malformed file
 * is reported as the suite expects; a read that fails (the suite's timeout, refusal, rate
 * limit and oversize answers) surfaces with its code, unchanged; a cancelled poll reads
 * nothing. The file-specific refusals the amended suite would add (a path outside the
 * folder, a link out of it, a missing file) are tested in files.test.ts against a real
 * folder through testing/host.ts.
 *
 * Nothing here is used outside tests. When A1 and A4 land, the frozen registry and suite do
 * this themselves; this file and its uses are deleted and the examples move up into
 * connectors/examples/files/, where `pnpm connector:test --all` runs them.
 */
export class FileSuiteRegistry extends ConnectorRegistry {
  override validate(doc: unknown): ConnectorValidationResult & { definition?: ConnectorProviderDefinition } {
    const parsed = parseDefinition(doc);
    if (!parsed.ok) return { ok: false, errors: parsed.issues, warnings: [] };
    let definition: ConnectorProviderDefinition = parsed.definition;
    const raw = doc && typeof doc === 'object' ? (doc as { file?: unknown }).file : undefined;
    if (raw !== undefined) {
      const file = fileSpecSchema.parse(raw);
      if (!file.ok)
        return {
          ok: false,
          errors: file.issues.map((i) => `file${i.path && i.path !== '$' ? `.${i.path}` : ''}: ${i.message}`),
          warnings: [],
          definition,
        };
      definition = { ...definition, file: file.value } as FileConnectorDefinition;
    }
    const connector = this.get(definition.connector);
    if (!connector)
      return { ok: false, errors: [`unknown connector "${definition.connector}"`], warnings: [], definition };
    return { ...connector.validate(definition), definition };
  }

  override createProvider(definition: ConnectorProviderDefinition): WorldProvider {
    if (definition.connector === LOCAL_FILE_CONNECTOR_ID)
      return new LocalFileProvider(definition, { source: suiteFixtureSource });
    if (definition.connector === GDAL_IMPORT_CONNECTOR_ID)
      return new GdalImportProvider(definition, { converter: suiteFixtureConverter });
    return super.createProvider(definition);
  }
}

/** The suite's fixture body as the file: fetched once per provider, dated by the suite's clock. */
export function suiteFixtureSource(context: ProviderContext, path: string): FileSource {
  let body: Promise<Uint8Array> | undefined;
  const fetchBody = (signal: AbortSignal) =>
    (body ??= context.http
      .request({ url: `https://fixture.invalid/${encodeURI(path)}`, signal })
      .then((res) => res.bytes()));
  return {
    stat: async (signal) => {
      const bytes = await fetchBody(signal);
      return { size: bytes.length, mtimeMs: context.clock.now() };
    },
    load: (_maxBytes, signal) => fetchBody(signal),
  };
}

/** For gdal-import: a found ogr2ogr whose output is the suite's fixture (a GeoJSON). */
export function suiteFixtureConverter(context: ProviderContext): Ogr2ogrAccess {
  const sources = new Map<string, FileSource>();
  const source = (input: string) => {
    let s = sources.get(input);
    if (!s) sources.set(input, (s = suiteFixtureSource(context, input)));
    return s;
  };
  return {
    detect: async () => ({ found: true, version: 'fixture (the suite stands in for ogr2ogr)' }),
    datasetStat: (input) => source(input).stat(new AbortController().signal),
    toGeoJson: (req) =>
      source(req.input).load(req.maxOutputBytes ?? Number.MAX_SAFE_INTEGER, req.signal ?? new AbortController().signal),
  };
}
