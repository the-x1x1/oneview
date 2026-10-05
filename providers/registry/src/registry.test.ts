import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema } from '@worldview/provider-sdk';
import { createAllProviders, createProviderById, providerFactories, providerIds } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface LicenseRecord {
  providerId: string;
  dataPolicy: Record<string, unknown>;
  commercialReview: string;
}

function licenseRecords(): Map<string, LicenseRecord> {
  const raw = JSON.parse(readFileSync(path.join(root, 'config', 'licenses', 'providers.json'), 'utf8')) as {
    records: LicenseRecord[];
  };
  return new Map(raw.records.map((r) => [r.providerId, r]));
}

test('registry: every key is a unique manifest id with a valid manifest and a fresh instance per call', () => {
  const map = providerFactories();
  const ids = Object.keys(map);
  assert.equal(new Set(ids).size, ids.length, 'duplicate registry keys');
  const seen = new Set<string>();
  for (const [key, factory] of Object.entries(map)) {
    const a = factory();
    const b = factory();
    assert.notEqual(a, b, `${key} factory must not share instances between hosts`);
    const parsed = manifestSchema.parse(a.manifest);
    assert.ok(parsed.ok, `${key} manifest invalid`);
    assert.equal(a.manifest.id, key, `registry key ${key} must equal the manifest id`);
    assert.equal(seen.has(a.manifest.id), false, `duplicate manifest id ${a.manifest.id}`);
    seen.add(a.manifest.id);
  }
  assert.deepEqual(providerIds(), [...ids].sort());
  assert.equal(createAllProviders().length, ids.length);
  assert.equal(createProviderById('usgs-earthquakes')?.manifest.id, 'usgs-earthquakes');
  assert.equal(createProviderById('not-a-provider'), undefined);
});

/** The permission flags the legal registry is authoritative for (same set the contract checklist compares). */
const POLICY_FLAGS = [
  'cacheAllowed',
  'rawPayloadRetentionAllowed',
  'normalizedRetentionAllowed',
  'redistributionAllowed',
  'offlinePackAllowed',
  'exportAllowed',
  'commercialUseAllowed',
  'attributionRequired',
] as const;

test('registry: every shipped provider has a legal registry record whose dataPolicy matches its manifest', () => {
  const records = licenseRecords();
  const missing: string[] = [];
  const diffs: string[] = [];
  for (const provider of createAllProviders()) {
    const manifest = provider.manifest;
    const record = records.get(manifest.id);
    if (!record) {
      missing.push(manifest.id);
      continue;
    }
    const mp = manifest.dataPolicy as unknown as Record<string, unknown>;
    for (const flag of POLICY_FLAGS) {
      if (record.dataPolicy[flag] !== mp[flag])
        diffs.push(`${manifest.id}.${flag}: manifest=${String(mp[flag])} registry=${String(record.dataPolicy[flag])}`);
    }
    if (manifest.commercialReview !== record.commercialReview)
      diffs.push(
        `${manifest.id}.commercialReview: manifest=${manifest.commercialReview} registry=${record.commercialReview}`,
      );
  }
  assert.deepEqual(missing, [], 'providers without a record in config/licenses/providers.json');
  assert.deepEqual(diffs, [], 'data policy diverges from the legal registry');
});

test('registry: the AIS secret-resolver seam only affects aisstream-io', () => {
  const withSeam = providerFactories({ aisSecretResolver: async () => 'k' });
  assert.deepEqual(Object.keys(withSeam), Object.keys(providerFactories()));
});

test("registry: no provider's own rate limit is tighter than its own poll cadence", () => {
  // Two providers shipped with a limiter set at or below the rate they poll themselves.
  // `nws-alerts` allowed 4 requests a minute while its zone resolver wanted 20 per poll, and
  // roughly four US weather alerts in five never reached the map — measured: zone-resolved
  // alerts went from 1 to 45 on the first poll after the fix. `adsb-lol` allowed exactly 6
  // against exactly 6 polls a minute, which leaves no room for the retry its own policy
  // permits or for a viewport-driven refresh. Whether that limit, rather than adsb.lol, was
  // behind its stale serves the old log could not say; the invariant stands either way.
  //
  // The client limiter is a safety net, not the cadence control: `intervalMs` decides how
  // often we ask, and a limit set to the same number turns the net into the constraint. The
  // relationship between the two is easy to break because they sit three lines apart and
  // nothing downstream complains — the limiter just quietly stops handing out slots.
  for (const factory of Object.values(providerFactories())) {
    const { id, transport, refreshPolicy: p } = factory().manifest;
    // 0 means "no client limit at all", and a provider that is pushed rather than polled
    // (a websocket stream) has no cadence to compare against.
    if (p.maxRequestsPerMinute === 0 || p.intervalMs === 0) continue;
    const pollsPerMinute = Math.ceil(60_000 / p.intervalMs);
    const needed = pollsPerMinute + p.maxRetries;
    assert.ok(
      p.maxRequestsPerMinute >= needed,
      `${id} (${transport}) polls ${pollsPerMinute}×/min and allows ${p.maxRetries} retries, ` +
        `so its limiter needs at least ${needed}/min — it is set to ${p.maxRequestsPerMinute}`,
    );
  }
});

test('registry: connector definitions become providers beside the hand-written ones, with valid manifests', async () => {
  const { loadConnectorDefinitions } = await import('./connectors.js');
  const loaded = loadConnectorDefinitions({ bundledDir: path.join(root, 'connectors', 'examples') }, providerIds());
  assert.deepEqual(loaded.problems, []);
  assert.ok(loaded.definitions.length >= 4);
  const map = providerFactories({ connectorDefinitions: loaded.definitions });
  for (const d of loaded.definitions) {
    const p = map[d.id]!();
    const parsed = manifestSchema.parse(p.manifest);
    assert.ok(parsed.ok, `${d.id} manifest invalid: ${JSON.stringify(parsed)}`);
    assert.equal(p.manifest.id, d.id);
    assert.match(p.manifest.description ?? '', /Connector: /);
    assert.equal(p.manifest.enabledByDefault, false, 'examples are off');
  }
  // A definition may not take a bundled provider's id.
  const clash = loadConnectorDefinitions({ bundledDir: path.join(root, 'connectors', 'examples') }, [
    ...providerIds(),
    'citibike-nyc-stations',
  ]);
  assert.ok(clash.problems.some((p) => /already used/.test(p.errors[0] ?? '')));
});

test('registry: a world pack’s definition set loads only when its signer is one of the operator’s publishers', async () => {
  const { loadConnectorDefinitions, packDefinitionFile, UNTRUSTED_PACK_DEFINITION } = await import('./connectors.js');
  const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wv-packdefs-'));
  const defs = path.join(dir, 'definitions');
  mkdirSync(defs);
  copyFileSync(
    path.join(root, 'connectors', 'examples', 'citibike-stations-rest.json'),
    path.join(defs, 'citibike-nyc-stations.json'),
  );
  // A pack file cannot declare itself reviewed: it loads as user-configured, like the operator's own.
  const doc = JSON.parse(readFileSync(path.join(defs, 'citibike-nyc-stations.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(
    path.join(defs, 'citibike-nyc-stations.json'),
    JSON.stringify({ ...doc, review: 'reviewed', enabled: true }),
  );

  const untrusted = loadConnectorDefinitions(
    { packSets: [{ packId: 'nyc-sources', dir: defs, trusted: false }] },
    providerIds(),
  );
  assert.deepEqual(untrusted.definitions, []);
  assert.deepEqual(untrusted.files, [
    {
      file: packDefinitionFile('nyc-sources', 'citibike-nyc-stations.json'),
      problems: [UNTRUSTED_PACK_DEFINITION],
      warnings: [],
    },
  ]);

  const trusted = loadConnectorDefinitions(
    { packSets: [{ packId: 'nyc-sources', dir: defs, trusted: true }] },
    providerIds(),
  );
  assert.deepEqual(trusted.problems, []);
  assert.deepEqual(
    trusted.definitions.map((d) => [d.id, d.review, d.enabled]),
    [['citibike-nyc-stations', 'user-configured', false]],
  );
  assert.equal(trusted.files[0]?.file, 'pack/nyc-sources/citibike-nyc-stations.json');

  // Shipped definitions come first: a pack cannot take a bundled id, and the operator's own
  // folder cannot take a pack's.
  const both = loadConnectorDefinitions(
    {
      bundledDir: path.join(root, 'connectors', 'examples'),
      packSets: [{ packId: 'nyc-sources', dir: defs, trusted: true }],
      userDir: defs,
    },
    providerIds(),
  );
  const refused = both.problems.map((p) => p.file);
  assert.ok(refused.includes('pack/nyc-sources/citibike-nyc-stations.json'), 'the bundled one keeps its id');
  assert.ok(refused.includes('citibike-nyc-stations.json'));
});
