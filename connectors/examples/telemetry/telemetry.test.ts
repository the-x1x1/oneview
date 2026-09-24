import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation } from '@worldview/world-model';
import { manifestSchema, telemetryDescriptorSchema } from '@worldview/provider-sdk';
import { definitionToManifest, parseDefinition, type ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { defaultConnectorRegistry, formatSuite, runConnectorSuite } from '@worldview/connector-runtime';
import { loadSidecar } from '@worldview/tool-connector-validator';
import { resolveTelemetry } from '@worldview/telemetry';

/**
 * Phase telemetry: the example definitions that carry a `telemetry` block. Each runs the
 * shared connector suite from its sidecar; then the block is checked against what the
 * definition maps (every series names a property the mapping writes) and followed through
 * to the manifest and to the Readings section's resolution of a mapped observation.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const EXAMPLES = readdirSync(here)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'))
  .sort();

function definition(file: string): ConnectorProviderDefinition {
  const parsed = parseDefinition(JSON.parse(readFileSync(path.join(here, file), 'utf8')));
  assert.ok(parsed.ok, `${file}: ${parsed.ok ? '' : parsed.issues.join('; ')}`);
  return parsed.definition;
}

/** The suite with `normal` replaced, returning the observations it produced. */
async function observationsFrom(file: string, normal: string, expectObservations: number): Promise<Observation[]> {
  const fixtures = loadSidecar(path.join(here, file.replace(/\.json$/, '.test.json')), root);
  let seen: Observation[] = [];
  const r = await runConnectorSuite(JSON.parse(readFileSync(path.join(here, file), 'utf8')), {
    ...fixtures,
    normal,
    expectObservations,
    verify: (observations) => {
      seen = observations;
      return undefined;
    },
  });
  assert.ok(r.passed, '\n' + formatSuite(r));
  return seen;
}

test('the telemetry examples exist and pass the connector suite', async (t) => {
  assert.deepEqual(EXAMPLES, ['csv-greenhouse-latest.json', 'nws-station-observations.json']);
  for (const file of EXAMPLES) {
    const fixtures = loadSidecar(path.join(here, file.replace(/\.json$/, '.test.json')), root);
    const r = await runConnectorSuite(JSON.parse(readFileSync(path.join(here, file), 'utf8')), fixtures);
    for (const line of formatSuite(r).split('\n')) t.diagnostic(line);
    assert.ok(r.passed, '\n' + formatSuite(r));
  }
});

test('each example is user-configured, disabled, opens no data policy, and its descriptor reaches the manifest', () => {
  for (const file of EXAMPLES) {
    const raw = JSON.parse(readFileSync(path.join(here, file), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['review'], 'user-configured', file);
    assert.equal(raw['enabled'], false, file);
    assert.equal(raw['dataPolicy'], undefined, `${file} opens no data policy`);
    const d = definition(file);
    assert.ok(d.telemetry, `${file} carries a telemetry block`);
    assert.ok(telemetryDescriptorSchema.parse(d.telemetry).ok);
    const manifest = definitionToManifest(d, d.connector);
    assert.ok(manifestSchema.parse(manifest).ok, `${file}: the manifest validates`);
    assert.deepEqual(manifest.telemetry, d.telemetry);
    assert.equal(manifest.enabledByDefault, false);
    assert.equal(manifest.dataPolicy.redistributionAllowed, false);
  }
});

test('every series names a property the mapping writes', () => {
  for (const file of EXAMPLES) {
    const d = definition(file);
    const mapped = new Set(Object.keys(d.mapping.properties ?? {}));
    for (const s of d.telemetry!.series) assert.ok(mapped.has(s.key), `${file}: ${s.key} is not a mapped property`);
  }
});

test('a mapped observation resolves to its source’s descriptor: names, units and limits as written', async () => {
  const [kphx] = await observationsFrom(
    'nws-station-observations.json',
    read('fixtures/connectors/telemetry/nws-kphx-latest.geojson'),
    1,
  );
  const d = definition('nws-station-observations.json');
  const r = resolveTelemetry({ objectType: d.objectType, properties: kphx!.payload, sourceDescriptors: [d.telemetry] });
  assert.equal(r?.origin, 'source');
  // The latest observation reports no gust, so the gust series is not offered for it.
  assert.deepEqual(
    r?.series.map((s) => s.key),
    ['temperatureC', 'dewPointC', 'humidityPct', 'pressureSeaLevelHpa', 'windSpeedMps'],
  );
  assert.deepEqual(r?.series[0]?.limits, { warnHigh: 43, critHigh: 46 });

  const greenhouse = await observationsFrom(
    'csv-greenhouse-latest.json',
    read('fixtures/connectors/telemetry/greenhouse-latest.csv'),
    2,
  );
  const g = definition('csv-greenhouse-latest.json');
  const benchA = greenhouse.find((o) => o.externalId === 'GH-A')!;
  const ra = resolveTelemetry({ objectType: 'sensor', properties: benchA.payload, sourceDescriptors: [g.telemetry] });
  assert.deepEqual(
    ra?.series.map((s) => s.name),
    ['Air temperature', 'Soil moisture', 'Logger battery'],
    'CO₂ is empty in the row',
  );
});

test('known gap (amendment request R4): a batch keeps one observation per object, so a backlog is not history', async () => {
  // The NWS endpoint returns newest first: of three observations of KPHX only the newest is kept.
  const nws = await observationsFrom(
    'nws-station-observations.json',
    read('fixtures/connectors/telemetry/nws-kphx-observations.geojson'),
    1,
  );
  assert.deepEqual(
    nws.map((o) => o.observedAt),
    ['2026-09-23T17:51:00.000Z'],
  );
  // An append-only log lists oldest first: the first row per sensor wins, so the log's
  // newest readings never arrive. When R4 lands this fails and the CSV example can read a log.
  const log = await observationsFrom(
    'csv-greenhouse-latest.json',
    read('fixtures/connectors/telemetry/greenhouse-log.csv'),
    2,
  );
  assert.deepEqual(
    log.map((o) => [o.externalId, o.observedAt]),
    [
      ['GH-A', '2026-09-23T18:00:00.000Z'],
      ['GH-B', '2026-09-23T18:00:00.000Z'],
    ],
  );
});

test('R5 (landed): a description the definition allows always makes a manifest the host accepts', () => {
  const doc = JSON.parse(readFileSync(path.join(here, 'csv-greenhouse-latest.json'), 'utf8')) as {
    description: string;
  };
  doc.description = `${doc.description} ${'x'.repeat(499 - doc.description.length - 1)}`;
  assert.equal(doc.description.length, 499);
  const validated = defaultConnectorRegistry.validate(doc);
  assert.ok(validated.ok && validated.definition, 'the definition validates');
  // The connector appends " Connector: <its display name>." within the manifest's 500
  // characters, and ProviderHost.register validates the manifest with this schema.
  const manifest = defaultConnectorRegistry.createProvider(validated.definition).manifest;
  assert.ok((manifest.description?.length ?? 0) <= 500);
  assert.match(manifest.description ?? '', /… Connector: .+\.$/);
  assert.equal(manifestSchema.parse(manifest).ok, true);
});
