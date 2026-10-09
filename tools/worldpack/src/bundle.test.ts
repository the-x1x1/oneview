import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldPackBuilder, regionPreset, seedPolicies } from '@worldview/offline';
import { BUNDLE_MANIFEST, BUNDLE_SUMS, checkBundle, makeBundle, sha256OfFile, writeBundle } from './bundle.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const fixture = (...p: string[]) => path.join(root, 'fixtures', ...p);

/** Two small Oahu packs from the bundled seed fixtures: places, and airports. */
async function oahuPacks(dir: string): Promise<void> {
  const builder = new WorldPackBuilder();
  for (const [id, include] of [
    ['oahu-places', 'places'],
    ['oahu-airports', 'airports'],
  ] as const)
    await builder.build({
      id,
      name: `O'ahu ${include}`,
      version: '1.0.0',
      region: { preset: 'oahu' },
      include: [include],
      sources: {
        placesGeoJsonPath: fixture('places', 'seed-places.geojson'),
        airportsGeoJsonPath: fixture('airports', 'seed-airports.geojson'),
      },
      policies: (p) => seedPolicies()[p],
      licenses: () => 'MIT',
      outputPath: path.join(dir, `${id}.worldpack`),
    });
}

test("the oahu preset is O'ahu, inside the Hawaii one", () => {
  const oahu = regionPreset('oahu')!.bounds;
  const hawaii = regionPreset('hawaii')!.bounds;
  assert.ok(
    oahu.west > hawaii.west && oahu.east < hawaii.east && oahu.south > hawaii.south && oahu.north < hawaii.north,
  );
  // Honolulu (21.31 N, 157.86 W) and Ka'ena Point (21.58 N, 158.28 W) are in it.
  const inside: Array<[number, number]> = [
    [21.31, -157.86],
    [21.58, -158.28],
  ];
  for (const [lat, lon] of inside)
    assert.ok(lat > oahu.south && lat < oahu.north && lon > oahu.west && lon < oahu.east);
});

test('bundle: verifies every pack, writes a manifest and SHA256SUMS, and a faithful copy checks out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-bundle-'));
  await oahuPacks(dir);
  const r = await makeBundle(dir, { now: () => Date.parse('2026-10-08T00:00:00Z') });
  assert.ok(r.ok, r.ok ? '' : r.issues.join('; '));
  if (!r.ok) return;
  assert.deepEqual(
    r.manifest.packs.map((p) => p.id),
    ['oahu-airports', 'oahu-places'],
  );
  for (const p of r.manifest.packs) {
    assert.equal(p.sha256, await sha256OfFile(path.join(dir, p.file)));
    assert.equal(p.signature, 'unsigned');
  }
  await writeBundle(dir, r.manifest);
  const sums = await fs.readFile(path.join(dir, BUNDLE_SUMS), 'utf8');
  assert.equal(sums.trim().split('\n').length, 2);

  // Copied to the field drive.
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-bundle-copy-'));
  for (const f of await fs.readdir(dir)) await fs.copyFile(path.join(dir, f), path.join(copy, f));
  assert.deepEqual(await checkBundle(copy), { ok: true, problems: [], checked: 2 });
});

test('bundle --check: a damaged, missing, extra or escaping file fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-bundle-bad-'));
  await oahuPacks(dir);
  const r = await makeBundle(dir);
  assert.ok(r.ok);
  if (!r.ok) return;
  await writeBundle(dir, r.manifest);
  const target = path.join(dir, 'oahu-places.worldpack');
  const bytes = await fs.readFile(target);
  bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0xff;
  await fs.writeFile(target, bytes);
  await fs.rm(path.join(dir, 'oahu-airports.worldpack'));
  await fs.writeFile(path.join(dir, 'stray.worldpack'), 'x');
  const check = await checkBundle(dir);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /oahu-places\.worldpack: SHA-256 differs/.test(p)));
  assert.ok(check.problems.some((p) => /oahu-airports\.worldpack: missing/.test(p)));
  assert.ok(check.problems.some((p) => /stray\.worldpack: not in the manifest/.test(p)));

  const manifest = JSON.parse(await fs.readFile(path.join(dir, BUNDLE_MANIFEST), 'utf8'));
  manifest.packs[0].file = '../../etc/passwd.worldpack';
  await fs.writeFile(path.join(dir, BUNDLE_MANIFEST), JSON.stringify(manifest));
  assert.ok((await checkBundle(dir)).problems.some((p) => /not a pack file name/.test(p)));
});

test('bundle: refuses a broken pack, two packs with one id, and an empty folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-bundle-refuse-'));
  assert.equal((await makeBundle(dir)).ok, false);
  await oahuPacks(dir);
  await fs.copyFile(path.join(dir, 'oahu-places.worldpack'), path.join(dir, 'zz-copy.worldpack'));
  await fs.writeFile(path.join(dir, 'broken.worldpack'), 'not a zip');
  const r = await makeBundle(dir);
  assert.equal(r.ok, false);
  const issues = r.ok ? [] : r.issues;
  assert.ok(issues.some((i) => /^broken\.worldpack: /.test(i)));
  assert.ok(issues.some((i) => /both the pack "oahu-places"/.test(i)));
});
