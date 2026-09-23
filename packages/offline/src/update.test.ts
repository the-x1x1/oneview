import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@worldview/provider-sdk';
import { buildUpdatePack } from './delta.js';
import { WorldPackRegistry } from './registry.js';
import { generatePackKeyPair } from './signature.js';
import { verifyWorldPack } from './verify.js';
import { defaultFiles, writeTestPack, type TestPackOptions } from '../test/helpers/pack.js';
import { tempDir } from '../test/helpers/raw-zip.js';

const { VirtualClock } = testing;
const T1 = '2026-09-21T10:00:00.000Z';
const T2 = '2026-09-22T10:00:00.000Z';
const T3 = '2026-09-23T10:00:00.000Z';

function registry(dataDir: string): WorldPackRegistry {
  return new WorldPackRegistry({
    dataDir,
    appVersion: '0.1.0-rc.3',
    clock: new VirtualClock(Date.parse('2026-09-23T12:00:00Z')),
  });
}

/** The same pack at a later build: the places layer changed, the index and notices did not. */
function laterFiles(tag: string) {
  const files = defaultFiles();
  const places = JSON.parse(files[0]!.data.toString('utf8')) as {
    features: Array<{ properties: { name: string } }>;
  };
  places.features[0]!.properties.name = `Honolulu (${tag})`;
  files[0] = { ...files[0]!, data: Buffer.from(JSON.stringify(places)) };
  return files;
}

async function pack(dir: string, name: string, opts: TestPackOptions): Promise<string> {
  const file = path.join(dir, name);
  await writeTestPack(file, opts);
  return file;
}

test('an update pack carries only what changed, and installs over the pack it was made from', async () => {
  const dir = await tempDir();
  const v1 = await pack(dir, 'v1.worldpack', { createdAt: T1 });
  const v2 = await pack(dir, 'v2.worldpack', { createdAt: T2, files: laterFiles('v2') });
  const update = await buildUpdatePack({ from: v1, to: v2, outputPath: path.join(dir, 'v1-v2.worldpack') });
  assert.deepEqual(update.carried, ['data/places.geojson']);
  assert.deepEqual(update.reused, ['search/index.json', 'licenses/NOTICES.md']);

  const v = await verifyWorldPack(update.outputPath);
  assert.ok(v.ok, v.issues.join('; '));
  assert.equal(v.entries.length, 1, 'only the changed file is in the archive');
  assert.deepEqual(v.update?.reused, update.reused);
  assert.equal(v.update?.baseCreatedAt, T1);

  const dataDir = path.join(dir, 'data');
  const reg = registry(dataDir);
  await reg.install(v1);
  const r = await reg.install(update.outputPath);
  assert.ok(r.installed, r.issues.join('; '));
  assert.match(r.issues[0] ?? '', /updated from the pack created 2026-09-21: 2 of 3 files kept/);
  assert.equal(reg.get('hawaii-test')?.manifest?.createdAt, T2);
  assert.equal((await reg.verifyInstalled('hawaii-test')).ok, true, 'every file matches the new manifest');
  assert.equal(reg.placeIndex().search('Honolulu')[0]?.entry.name, 'Honolulu', 'the kept index still answers');
  const places = await fs.readFile(path.join(dataDir, 'worldpacks', 'hawaii-test', 'data', 'places.geojson'), 'utf8');
  assert.match(places, /Honolulu \(v2\)/);

  // An update can follow an update: v2 → v3 made against the installed v2 (itself from an update).
  const v3 = await pack(dir, 'v3.worldpack', { createdAt: T3, files: laterFiles('v3') });
  const again = await buildUpdatePack({
    from: update.outputPath,
    to: v3,
    outputPath: path.join(dir, 'v2-v3.worldpack'),
  });
  const r3 = await reg.install(again.outputPath);
  assert.ok(r3.installed, r3.issues.join('; '));
  assert.equal(reg.get('hawaii-test')?.manifest?.createdAt, T3);
  await fs.rm(dir, { recursive: true, force: true });
});

test('an update applies only to the exact pack it was made from, and only when that pack is intact', async () => {
  const dir = await tempDir();
  const v1 = await pack(dir, 'v1.worldpack', { createdAt: T1 });
  const v1b = await pack(dir, 'v1b.worldpack', { createdAt: T1, name: 'Another build of the same day' });
  const v2 = await pack(dir, 'v2.worldpack', { createdAt: T2, files: laterFiles('v2') });
  const update = await buildUpdatePack({ from: v1, to: v2, outputPath: path.join(dir, 'u.worldpack') });

  const nothing = registry(path.join(dir, 'empty'));
  const missing = await nothing.install(update.outputPath);
  assert.equal(missing.installed, null);
  assert.match(
    missing.issues.join(';'),
    /update for the "hawaii-test" pack created 2026-09-21, which is not installed/,
  );

  const other = registry(path.join(dir, 'other'));
  await other.install(v1b);
  const wrong = await other.install(update.outputPath);
  assert.equal(wrong.installed, null);
  assert.match(wrong.issues.join(';'), /install the full pack instead/);
  assert.equal(
    other.get('hawaii-test')?.summary.name,
    'Another build of the same day',
    'the installed pack is untouched',
  );

  // The right base, but a kept file edited on disk (same size): refused before anything is replaced.
  const edited = registry(path.join(dir, 'edited'));
  await edited.install(v1);
  const index = path.join(dir, 'edited', 'worldpacks', 'hawaii-test', 'search', 'index.json');
  const text = await fs.readFile(index, 'utf8');
  await fs.writeFile(index, text.replace('Honolulu', 'Honolulx'));
  const r = await edited.install(update.outputPath);
  assert.equal(r.installed, null);
  assert.match(r.issues.join(';'), /search\/index\.json: the installed copy does not match/);
  assert.equal(edited.get('hawaii-test')?.manifest?.createdAt, T1, 'still the old pack');
  assert.deepEqual(
    (await fs.readdir(path.join(dir, 'edited', 'worldpacks', '.staging')).catch(() => [])).length,
    0,
    'staging cleaned',
  );

  await assert.rejects(
    buildUpdatePack({ from: v2, to: v1, outputPath: path.join(dir, 'back.worldpack') }),
    /not newer/,
  );
  const elsewhere = await pack(dir, 'x.worldpack', { id: 'other-pack', createdAt: T2 });
  await assert.rejects(
    buildUpdatePack({ from: v1, to: elsewhere, outputPath: path.join(dir, 'y.worldpack') }),
    /different packs/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('replacing an installed pack: never with an older one, never with a different signer’s', async () => {
  const dir = await tempDir();
  const alice = generatePackKeyPair();
  const bob = generatePackKeyPair();
  const reg = registry(path.join(dir, 'data'));
  const newer = await pack(dir, 'newer.worldpack', { createdAt: T2 });
  const older = await pack(dir, 'older.worldpack', { createdAt: T1 });
  await reg.install(newer);
  const down = await reg.install(older);
  assert.equal(down.installed, null);
  assert.match(down.issues.join(';'), /older than the installed "hawaii-test" pack .* remove the installed pack first/);
  await reg.remove('hawaii-test');

  await reg.install(await pack(dir, 'a1.worldpack', { createdAt: T1, signWith: alice.privateKeyPem }));
  const unsigned = await reg.install(await pack(dir, 'u2.worldpack', { createdAt: T2 }));
  assert.equal(unsigned.installed, null);
  assert.match(unsigned.issues.join(';'), /signed with key .*; this one is not signed/);
  const byBob = await pack(dir, 'b2.worldpack', { createdAt: T2, signWith: bob.privateKeyPem });
  assert.match((await reg.install(byBob)).issues.join(';'), /this one is signed with key/);
  const byAlice = await reg.install(await pack(dir, 'a2.worldpack', { createdAt: T2, signWith: alice.privateKeyPem }));
  assert.ok(byAlice.installed, 'the same signer may update her pack');
  assert.match(byAlice.issues[0] ?? '', /replaced the pack created 2026-09-21/);

  // Bob, once the operator trusts him, may replace it — that is the operator's decision.
  await reg.addPublisher('Bob', bob.publicKey);
  const byTrustedBob = await reg.install(
    await pack(dir, 'b3.worldpack', { createdAt: T3, signWith: bob.privateKeyPem }),
  );
  assert.ok(byTrustedBob.installed, byTrustedBob.issues.join('; '));
  await fs.rm(dir, { recursive: true, force: true });
});
