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
  // Two providers shipped with a limiter set at or below the rate they poll themselves, and
  // in both cases the symptom was missing data rather than an error. `nws-alerts` allowed 4
  // requests a minute while its zone resolver wanted 20 per poll, so roughly four US weather
  // alerts in five never reached the map. `adsb-lol` allowed exactly 6 against exactly 6
  // polls a minute, so any retry or viewport-driven refresh pushed it over and the poll
  // served stale aircraft — 801 times in one log.
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
