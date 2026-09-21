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
  const raw = JSON.parse(readFileSync(path.join(root, 'config', 'licenses', 'providers.json'), 'utf8')) as { records: LicenseRecord[] };
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
  'cacheAllowed', 'rawPayloadRetentionAllowed', 'normalizedRetentionAllowed', 'redistributionAllowed',
  'offlinePackAllowed', 'exportAllowed', 'commercialUseAllowed', 'attributionRequired',
] as const;

test('registry: every shipped provider has a legal registry record whose dataPolicy matches its manifest', () => {
  const records = licenseRecords();
  const missing: string[] = [];
  const diffs: string[] = [];
  for (const provider of createAllProviders()) {
    const manifest = provider.manifest;
    const record = records.get(manifest.id);
    if (!record) { missing.push(manifest.id); continue; }
    const mp = manifest.dataPolicy as unknown as Record<string, unknown>;
    for (const flag of POLICY_FLAGS) {
      if (record.dataPolicy[flag] !== mp[flag]) diffs.push(`${manifest.id}.${flag}: manifest=${String(mp[flag])} registry=${String(record.dataPolicy[flag])}`);
    }
    if (manifest.commercialReview !== record.commercialReview) diffs.push(`${manifest.id}.commercialReview: manifest=${manifest.commercialReview} registry=${record.commercialReview}`);
  }
  assert.deepEqual(missing, [], 'providers without a record in config/licenses/providers.json');
  assert.deepEqual(diffs, [], 'data policy diverges from the legal registry');
});

test('registry: the AIS secret-resolver seam only affects aisstream-io', () => {
  const withSeam = providerFactories({ aisSecretResolver: async () => 'k' });
  assert.deepEqual(Object.keys(withSeam), Object.keys(providerFactories()));
});
