import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findManifests, runLicenseAudit, readManifestSource } from './audit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MANIFEST = `import type { ProviderManifest } from '@worldview/provider-sdk';
export const M: ProviderManifest = {
  id: 'demo-source',
  name: 'Demo',
  version: '0.1.0',
  objectTypes: ['earthquake'],
  categories: ['earth'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: { intervalMs: 60000, minIntervalMs: 60000, timeoutMs: 15000, maxRetries: 2, maxRequestsPerMinute: 4, staleWhileErrorMs: 0 },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: true,
    commercialUseAllowed: 'conditional',
    attributionRequired: true,
    attributionText: 'Demo source',
  },
  attribution: { text: 'Demo source' },
  commercialReview: 'conditional',
  enabledByDefault: true,
  allowedHosts: ['demo.example'],
};
`;

function scaffold(overrides: { record?: Record<string, unknown>; manifest?: string } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-audit-'));
  mkdirSync(path.join(dir, 'providers', 'demo', 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'config', 'licenses'), { recursive: true });
  writeFileSync(path.join(dir, 'providers', 'demo', 'src', 'manifest.ts'), overrides.manifest ?? MANIFEST);
  const record = {
    providerId: 'demo-source',
    name: 'Demo',
    license: 'CC BY 4.0',
    plannedStatus: 'default',
    commercialReview: 'conditional',
    dataPolicy: {
      cacheAllowed: true,
      rawPayloadRetentionAllowed: false,
      normalizedRetentionAllowed: true,
      redistributionAllowed: false,
      offlinePackAllowed: false,
      exportAllowed: true,
      commercialUseAllowed: 'conditional',
      attributionRequired: true,
      attributionText: 'Demo source',
    },
    ...overrides.record,
  };
  writeFileSync(path.join(dir, 'config', 'licenses', 'providers.json'), JSON.stringify({ records: [record] }));
  writeFileSync(
    path.join(dir, 'config', 'licenses', 'software.json'),
    JSON.stringify({
      records: [{ name: 'electron', license: 'MIT', distribution: 'bundled', commercialReview: 'approved' }],
    }),
  );
  writeFileSync(
    path.join(dir, 'config', 'licenses', 'assets.json'),
    JSON.stringify({
      records: [{ path: 'public/models/x.glb', license: 'CC BY 4.0', attribution: 'someone', decision: 'bundle' }],
    }),
  );
  return dir;
}

test('manifest source extraction reads ids, review state and the data policy', () => {
  const m = readManifestSource(MANIFEST);
  assert.equal(m.id, 'demo-source');
  assert.equal(m.commercialReview, 'conditional');
  assert.equal(m.enabledByDefault, true);
  assert.equal(m.dataPolicy['redistributionAllowed'], false);
  assert.equal(m.dataPolicy['commercialUseAllowed'], 'conditional');
});

test('a consistent registry passes', () => {
  const dir = scaffold();
  try {
    const report = runLicenseAudit(dir);
    assert.equal(report.passed, true, JSON.stringify(report.findings));
    assert.equal(report.providers.matched, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy divergence between manifest and registry fails closed', () => {
  const dir = scaffold({
    record: {
      dataPolicy: {
        cacheAllowed: true,
        rawPayloadRetentionAllowed: false,
        normalizedRetentionAllowed: true,
        redistributionAllowed: true,
        offlinePackAllowed: false,
        exportAllowed: true,
        commercialUseAllowed: 'conditional',
        attributionRequired: true,
        attributionText: 'Demo source',
      },
    },
  });
  try {
    const report = runLicenseAudit(dir);
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((f) => f.message.includes('dataPolicy.redistributionAllowed mismatch')),
      JSON.stringify(report.findings),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider with no registry record fails closed', () => {
  const dir = scaffold({ record: { providerId: 'other-source' } });
  try {
    const report = runLicenseAudit(dir);
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((f) => f.message.includes('no record in config/licenses/providers.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an excluded provider may not be enabled by default', () => {
  const dir = scaffold({ record: { commercialReview: 'excluded' } });
  try {
    const report = runLicenseAudit(dir);
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((f) => f.message.includes('enabled by default')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second manifest one directory down is audited too', () => {
  const dir = scaffold();
  try {
    mkdirSync(path.join(dir, 'providers', 'demo', 'src', 'strict'), { recursive: true });
    writeFileSync(
      path.join(dir, 'providers', 'demo', 'src', 'strict', 'manifest.ts'),
      MANIFEST.replace("id: 'demo-source'", "id: 'demo-strict'"),
    );
    const report = runLicenseAudit(dir);
    assert.equal(report.providers.manifests, 2);
    assert.equal(report.passed, false, 'the nested provider has no record');
    assert.ok(report.findings.some((f) => f.subject === 'demo-strict' && f.message.includes('no record')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository itself passes the audit', () => {
  const report = runLicenseAudit(repoRoot);
  assert.equal(report.passed, true, report.findings.map((f) => `${f.severity} ${f.subject}: ${f.message}`).join('\n'));
  assert.equal(report.providers.matched, report.providers.manifests);
  assert.ok(report.providers.manifests >= 10, `only ${report.providers.manifests} provider manifests found`);
  assert.ok(
    findManifests(repoRoot).some((m) => m.dir === 'cctv-public/unverified'),
    'the unverified camera provider is audited',
  );
});

const DEFINITION = {
  schema: 'oneview.connector.v1',
  id: 'demo-definition',
  name: 'Demo definition',
  connector: 'geojson',
  objectType: 'earthquake',
  endpoint: { url: 'https://demo.example/feed.geojson' },
  mapping: { externalId: 'id' },
  attribution: { text: 'Demo definition source' },
  review: 'bundled',
  enabled: true,
};
const DEFINITION_RECORD = {
  providerId: 'demo-definition',
  name: 'Demo definition',
  license: 'CC BY 4.0',
  plannedStatus: 'default',
  commercialReview: 'conditional',
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: true,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: 'unknown',
    attributionRequired: true,
    attributionText: 'Demo definition source',
  },
};

function withDefinition(dir: string, definition: Record<string, unknown>, record?: Record<string, unknown>): void {
  mkdirSync(path.join(dir, 'connectors', 'enabled'), { recursive: true });
  writeFileSync(path.join(dir, 'connectors', 'enabled', 'demo.json'), JSON.stringify(definition));
  writeFileSync(path.join(dir, 'connectors', 'enabled', 'demo.test.json'), '{"not":"a definition"}');
  const registry = path.join(dir, 'config', 'licenses', 'providers.json');
  const current = JSON.parse(readFileSync(registry, 'utf8')) as { records: unknown[] };
  if (record) current.records.push(record);
  writeFileSync(registry, JSON.stringify(current));
}

test('a shipped connector definition is audited like a manifest: reviewed, recorded, policy equal', () => {
  const dir = scaffold();
  withDefinition(dir, DEFINITION, DEFINITION_RECORD);
  const report = runLicenseAudit(dir, () => 0);
  assert.equal(report.providers.definitions, 1, 'the sidecar is not a definition');
  assert.deepEqual(report.findings, []);
  assert.equal(report.providers.matched, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('a shipped definition that is user-configured, unrecorded, or opens policy the record lacks fails closed', () => {
  const unreviewed = scaffold();
  withDefinition(unreviewed, { ...DEFINITION, review: 'user-configured' }, DEFINITION_RECORD);
  assert.match(
    runLicenseAudit(unreviewed, () => 0)
      .findings.map((f) => f.message)
      .join('\n'),
    /shipped but not reviewed/,
  );
  rmSync(unreviewed, { recursive: true, force: true });

  const unrecorded = scaffold();
  withDefinition(unrecorded, DEFINITION);
  assert.match(
    runLicenseAudit(unrecorded, () => 0)
      .findings.map((f) => f.message)
      .join('\n'),
    /no record in config/,
  );
  rmSync(unrecorded, { recursive: true, force: true });

  const opened = scaffold();
  withDefinition(opened, { ...DEFINITION, dataPolicy: { exportAllowed: true } }, DEFINITION_RECORD);
  const r = runLicenseAudit(opened, () => 0);
  assert.match(
    r.findings.map((f) => f.message).join('\n'),
    /dataPolicy\.exportAllowed mismatch: definition=true registry=false/,
  );
  assert.equal(r.passed, false);
  rmSync(opened, { recursive: true, force: true });

  const manual = scaffold();
  withDefinition(manual, DEFINITION, { ...DEFINITION_RECORD, commercialReview: 'manual-review-required' });
  assert.match(
    runLicenseAudit(manual, () => 0)
      .findings.map((f) => f.message)
      .join('\n'),
    /commercialReview mismatch/,
  );
  rmSync(manual, { recursive: true, force: true });
});

test('the audit reads the same fail-closed defaults and review mapping the connector SDK applies', async () => {
  const sdk = await import('@worldview/connector-sdk');
  const { DEFINITION_POLICY_DEFAULTS, readDefinitionFacts } = await import('./audit.js');
  for (const [key, value] of Object.entries(DEFINITION_POLICY_DEFAULTS))
    assert.equal((sdk.defaultDataPolicy as unknown as Record<string, unknown>)[key], value, key);
  for (const review of ['user-configured', 'bundled', 'commercially-reviewed'] as const) {
    const parsed = sdk.parseDefinition({
      ...DEFINITION,
      review,
      enabled: true,
      endpoint: { url: 'https://demo.example/feed.geojson' },
    });
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const manifest = sdk.definitionToManifest(parsed.definition, 'GeoJSON');
    const facts = readDefinitionFacts(JSON.stringify({ ...DEFINITION, review, enabled: true }));
    assert.ok(!('error' in facts));
    assert.equal(facts.commercialReview, manifest.commercialReview, review);
    assert.equal(facts.enabledByDefault, manifest.enabledByDefault, review);
    for (const key of Object.keys(DEFINITION_POLICY_DEFAULTS))
      assert.equal(
        facts.dataPolicy[key],
        (manifest.dataPolicy as unknown as Record<string, unknown>)[key],
        `${review} ${key}`,
      );
  }
});
