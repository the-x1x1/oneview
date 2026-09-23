import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compareSemver, parseWorldPackManifest, type WorldPackManifest } from './manifest.js';
import { extractWorldPack, verifyWorldPack } from './verify.js';
import { buildTestPack, writeTestPack, TEST_POLICY, sha256 } from '../test/helpers/pack.js';
import { tempDir, writeTemp } from '../test/helpers/raw-zip.js';

function valid(): WorldPackManifest {
  return buildTestPack().manifest;
}

function expectInvalid(mutate: (m: WorldPackManifest) => unknown, pattern: RegExp): void {
  const m = valid();
  const v = mutate(m) ?? m;
  const r = parseWorldPackManifest(JSON.parse(JSON.stringify(v)));
  assert.equal(r.ok, false, `expected ${pattern}`);
  if (!r.ok) assert.match(r.issues.join('\n'), pattern);
}

test('manifest: a builder-shaped manifest parses and round-trips', () => {
  const r = parseWorldPackManifest(JSON.parse(JSON.stringify(valid())));
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.manifest.formatVersion, 1);
    assert.equal(r.manifest.contents.length, 3);
    assert.equal(r.manifest.sourcePolicies[0]?.attribution, TEST_POLICY.attribution);
  }
});

test('manifest: strict schema rejects structural problems', () => {
  expectInvalid((m) => ({ ...m, extra: 1 }), /unexpected key/);
  expectInvalid((m) => ({ ...m, formatVersion: 2 }), /formatVersion/);
  expectInvalid((m) => ({ ...m, id: 'Not Kebab' }), /id/);
  expectInvalid((m) => ({ ...m, createdAt: '2026-09-21' }), /ISO 8601/);
  expectInvalid((m) => ({ ...m, minimumAppVersion: 'v1' }), /minimumAppVersion/);
  expectInvalid(
    (m) => ({ ...m, geographicBounds: { west: 0, south: 10, east: 1, north: 5 } }),
    /south must be <= north/,
  );
  expectInvalid((m) => ({ ...m, expiresAt: '2020-01-01T00:00:00.000Z' }), /expiresAt before createdAt/);
  expectInvalid((m) => ({ ...m, contents: [] }), /at least 1/);
});

test('manifest: content path rules, checksums and policies are cross-checked', () => {
  expectInvalid((m) => {
    m.contents[0]!.path = 'data/places.exe';
    m.checksums['data/places.exe'] = m.contents[0]!.sha256;
    delete m.checksums['data/places.geojson'];
  }, /not allowed for kind/);
  expectInvalid((m) => {
    m.contents[0]!.path = 'other/places.geojson';
    m.checksums['other/places.geojson'] = m.contents[0]!.sha256;
    delete m.checksums['data/places.geojson'];
  }, /not allowed for kind/);
  expectInvalid((m) => {
    m.checksums['data/places.geojson'] = 'ab'.repeat(32);
  }, /must equal contents sha256/);
  expectInvalid((m) => {
    m.checksums['data/extra.geojson'] = 'ab'.repeat(32);
  }, /has no contents entry/);
  expectInvalid((m) => {
    m.contents.push({ ...m.contents[0]! });
  }, /duplicate content path/);
  expectInvalid((m) => {
    m.contents[0]!.providerId = 'someone-else';
  }, /without a sourcePolicies entry/);
  expectInvalid((m) => {
    m.sourcePolicies[0]!.offlinePackAllowed = false;
  }, /not allowed in a world pack/);
  expectInvalid((m) => {
    m.sourcePolicies[0]!.redistributionAllowed = false;
  }, /not allowed in a world pack/);
  expectInvalid((m) => {
    m.sourcePolicies.push({ ...TEST_POLICY, providerId: 'unused-provider' });
  }, /not used by any content/);
  expectInvalid((m) => {
    m.contents = m.contents.filter((c) => c.kind !== 'notices');
    delete m.checksums['licenses/NOTICES.md'];
  }, /NOTICES\.md/);
  expectInvalid((m) => {
    m.contents.push({ path: 'manifest.json', kind: 'geojson', sizeBytes: 1, sha256: 'ab'.repeat(32) });
    m.checksums['manifest.json'] = 'ab'.repeat(32);
  }, /not allowed for kind|cannot list itself/);
});

test('manifest: compareSemver orders numerically with pre-release before release', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1);
  assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  // Pre-release identifiers compare numerically: rc.10 is after rc.9 (it compared as text).
  assert.equal(compareSemver('0.1.0-rc.10', '0.1.0-rc.9'), 1);
  assert.equal(compareSemver('0.1.0-rc.3', '0.1.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1, 'numeric before alphanumeric');
  assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0);
});

test('verify: a well-formed pack verifies, and every tampering path is reported', async () => {
  const dir = await tempDir();
  const good = path.join(dir, 'good.worldpack');
  await writeTestPack(good);
  const v = await verifyWorldPack(good, { appVersion: '0.1.0' });
  assert.equal(v.ok, true, v.issues.join('; '));
  assert.equal(v.entries.length, 3);
  assert.equal(v.manifest?.id, 'hawaii-test');

  const tampered = path.join(dir, 'tampered.worldpack');
  await writeTestPack(tampered, {
    mutateManifest: (m) => {
      m.checksums['data/places.geojson'] = 'ab'.repeat(32);
      m.contents[0]!.sha256 = 'ab'.repeat(32);
    },
  });
  const t = await verifyWorldPack(tampered);
  assert.equal(t.ok, false);
  assert.match(t.issues.join('\n'), /SHA-256 mismatch/);

  const extra = path.join(dir, 'extra.worldpack');
  await writeTestPack(extra, { extraEntries: [{ name: 'data/smuggled.geojson', data: Buffer.from('{}') }] });
  const e = await verifyWorldPack(extra);
  assert.equal(e.ok, false);
  assert.match(e.issues.join('\n'), /not listed in the manifest/);

  const missing = path.join(dir, 'missing.worldpack');
  await writeTestPack(missing, { omitEntries: ['data/places.geojson'] });
  const m = await verifyWorldPack(missing);
  assert.equal(m.ok, false);
  assert.match(m.issues.join('\n'), /no such entry/);

  const noManifest = path.join(dir, 'nomanifest.worldpack');
  await writeTestPack(noManifest, { omitManifest: true });
  const n = await verifyWorldPack(noManifest);
  assert.equal(n.ok, false);
  assert.match(n.issues.join('\n'), /manifest\.json not found/);

  const badJson = path.join(dir, 'badjson.worldpack');
  await writeTestPack(badJson, { mutateManifest: () => 'not-an-object' });
  const b = await verifyWorldPack(badJson);
  assert.equal(b.ok, false);
  assert.match(b.issues.join('\n'), /manifest/);

  const sizeLie = path.join(dir, 'sizelie.worldpack');
  await writeTestPack(sizeLie, {
    mutateManifest: (m) => {
      m.contents[0]!.sizeBytes += 1;
    },
  });
  const s = await verifyWorldPack(sizeLie);
  assert.equal(s.ok, false);
  assert.match(s.issues.join('\n'), /bytes, archive declares/);

  const newer = path.join(dir, 'newer.worldpack');
  await writeTestPack(newer, { minimumAppVersion: '9.0.0' });
  const nv = await verifyWorldPack(newer, { appVersion: '0.1.0' });
  assert.equal(nv.ok, false);
  assert.match(nv.issues.join('\n'), /requires app version >= 9\.0\.0/);

  const expired = path.join(dir, 'expired.worldpack');
  await writeTestPack(expired, { expiresAt: '2026-10-01T00:00:00.000Z' });
  const ex = await verifyWorldPack(expired, { now: Date.parse('2026-12-01T00:00:00Z') });
  assert.equal(ex.ok, true);
  assert.match(ex.warnings.join('\n'), /expired/);

  const notZip = await writeTemp(dir, 'notzip.worldpack', Buffer.from('this is not a zip archive at all, just text'));
  const nz = await verifyWorldPack(notZip);
  assert.equal(nz.ok, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('extract: writes exactly the archive files into the target and removes everything on failure', async () => {
  const dir = await tempDir();
  const good = path.join(dir, 'good.worldpack');
  const manifest = await writeTestPack(good);
  const target = path.join(dir, 'out');
  const v = await extractWorldPack(good, target);
  assert.equal(v.ok, true, v.issues.join('; '));
  const written = await fs.readFile(path.join(target, 'data', 'places.geojson'));
  assert.equal(sha256(written), manifest.checksums['data/places.geojson']);
  assert.ok((await fs.stat(path.join(target, 'manifest.json'))).isFile());
  assert.ok((await fs.stat(path.join(target, 'licenses', 'NOTICES.md'))).isFile());

  const bad = path.join(dir, 'bad.worldpack');
  await writeTestPack(bad, {
    mutateManifest: (m) => {
      m.checksums['search/index.json'] = 'cd'.repeat(32);
      m.contents[1]!.sha256 = 'cd'.repeat(32);
    },
  });
  const target2 = path.join(dir, 'out2');
  const v2 = await extractWorldPack(bad, target2);
  assert.equal(v2.ok, false);
  await assert.rejects(fs.stat(target2), /ENOENT/);
  await fs.rm(dir, { recursive: true, force: true });
});
