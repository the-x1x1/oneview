import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@worldview/provider-sdk';
import { WorldPackBuilder, WorldPackBuildError } from './builder.js';
import { parseWorldPackManifest } from './manifest.js';
import { WorldPackRegistry } from './registry.js';
import { generatePackKeyPair } from './signature.js';
import { verifyWorldPack } from './verify.js';
import { tempDir } from '../test/helpers/raw-zip.js';

const { VirtualClock } = testing;
const ALICE = generatePackKeyPair();

const definition = (id: string) => ({
  id,
  name: `Gauges ${id}`,
  connector: 'geojson',
  endpoint: { url: 'https://example.org/gauges.geojson' },
});

async function definitionsFolder(dir: string, docs: Record<string, unknown>): Promise<string> {
  const folder = path.join(dir, 'defs');
  await fs.mkdir(folder, { recursive: true });
  for (const [name, doc] of Object.entries(docs))
    await fs.writeFile(path.join(folder, name), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return folder;
}

function build(dir: string, definitionsDir: string, signingKeyPem?: string) {
  return new WorldPackBuilder().build({
    id: 'county-sources',
    name: 'County sources',
    region: { bounds: { west: -161, south: 18.5, east: -154.5, north: 22.5 } },
    include: ['definitions'],
    sources: { definitionsDir },
    policies: () => undefined,
    outputPath: path.join(dir, 'county-sources.worldpack'),
    clock: new VirtualClock(Date.parse('2026-10-04T00:00:00Z')),
    ...(signingKeyPem ? { signingKeyPem } : {}),
  });
}

test('definition set: a pack carries definitions as definitions/<id>.json, named in NOTICES', async () => {
  const dir = await tempDir();
  const defs = await definitionsFolder(dir, {
    'county-gauges.json': definition('county-gauges'),
    'county-cameras.json': definition('county-cameras'),
    'county-gauges.test.json': { fixture: true },
  });
  const report = await build(dir, defs, ALICE.privateKeyPem);
  assert.deepEqual(report.layers.definitions?.files, ['county-cameras.json', 'county-gauges.json']);
  assert.deepEqual(report.warnings, []);
  const verified = await verifyWorldPack(report.outputPath);
  assert.ok(verified.ok, verified.issues.join('; '));
  assert.deepEqual(
    verified.manifest!.contents.filter((c) => c.kind === 'definitions').map((c) => c.path),
    ['definitions/county-cameras.json', 'definitions/county-gauges.json'],
  );
  assert.equal(verified.signature?.status, 'signed');

  const unsigned = await build(await tempDir(), defs);
  assert.match(unsigned.warnings.join(' '), /not signed/);
});

test('definition set: a file that is not <id>.json holding that id is refused before anything is written', async () => {
  for (const [name, doc] of [
    ['Bad Name.json', definition('bad-name')],
    ['gauges.json', definition('other-id')],
    ['gauges.json', 'not json'],
    ['gauges.json', [1, 2]],
  ] as const) {
    const dir = await tempDir();
    const defs = await definitionsFolder(dir, { [name]: doc });
    await assert.rejects(build(dir, defs), (err: unknown) => err instanceof WorldPackBuildError, name);
    await assert.rejects(fs.stat(path.join(dir, 'county-sources.worldpack')), /ENOENT/);
  }
  const empty = await tempDir();
  await assert.rejects(build(empty, await definitionsFolder(empty, {})), /no \*\.json definitions/);
});

test('definition set: the manifest admits definitions only under definitions/, named as an id', () => {
  const base = {
    formatVersion: 1,
    id: 'x-pack',
    name: 'X',
    createdAt: '2026-10-04T00:00:00.000Z',
    geographicBounds: { west: 0, south: 0, east: 1, north: 1 },
    sourcePolicies: [],
    minimumAppVersion: '0.1.0',
  };
  const sha = 'a'.repeat(64);
  const notices = { path: 'licenses/NOTICES.md', kind: 'notices', sizeBytes: 1, sha256: 'b'.repeat(64) };
  const with_ = (p: string) => ({
    ...base,
    contents: [{ path: p, kind: 'definitions', sizeBytes: 10, sha256: sha }, notices],
    checksums: { [p]: sha, 'licenses/NOTICES.md': 'b'.repeat(64) },
  });
  assert.ok(parseWorldPackManifest(with_('definitions/county-gauges.json')).ok);
  for (const bad of [
    'data/county-gauges.json',
    'definitions/../x.json',
    'definitions/Upper.json',
    'definitions/a/b.json',
  ])
    assert.equal(parseWorldPackManifest(with_(bad)).ok, false, bad);
});

test('definition set: offered to the runtime only from an enabled pack, trusted only when its signer is a publisher', async () => {
  const dir = await tempDir();
  const defs = await definitionsFolder(dir, { 'county-gauges.json': definition('county-gauges') });
  const report = await build(dir, defs, ALICE.privateKeyPem);
  const dataDir = await tempDir();
  const reg = new WorldPackRegistry({
    dataDir,
    appVersion: '0.2.1',
    clock: new VirtualClock(Date.parse('2026-10-04T12:00:00Z')),
  });
  await reg.refresh();
  await reg.install(report.outputPath);

  const sets = reg.definitionSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.trusted, false, 'signed, but not by one of the operator’s publishers');
  assert.equal(sets[0]!.packName, 'County sources');
  const file = path.join(sets[0]!.dir, 'county-gauges.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), definition('county-gauges'));

  await reg.trustPackPublisher('county-sources', 'Alice Maps');
  assert.deepEqual(
    reg.definitionSets().map((s) => [s.trusted, s.publisher]),
    [[true, 'Alice Maps']],
  );
  await reg.setEnabled('county-sources', false);
  assert.deepEqual(reg.definitionSets(), [], 'a switched-off pack offers nothing');
});
