import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeatureCollection } from './geojson.js';
import { airportsFromFeatures, placesFromFeatures } from './place-entries.js';
import { PlaceIndex, type PlaceEntry } from './place-index.js';
import { CompositePlaceSearch, SqlitePlaceIndex, loadSqlite } from './place-sqlite.js';
import { WorldPackRegistry } from './registry.js';
import { writeTestPack } from '../test/helpers/pack.js';
import { tempDir } from '../test/helpers/raw-zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const seed = (file: string, convert: typeof placesFromFeatures): PlaceEntry[] => {
  const parsed = parseFeatureCollection(JSON.parse(readFileSync(path.join(root, 'fixtures', file), 'utf8')));
  assert.ok(parsed.ok);
  return convert(parsed.collection).entries;
};
const ENTRIES = [
  ...seed('places/seed-places.geojson', placesFromFeatures),
  ...seed('airports/seed-airports.geojson', airportsFromFeatures),
];
const sqlite = await loadSqlite();

test('node:sqlite, where this runtime has it, carries FTS5', (t) => {
  // Node 22.13+ and the Electron main process have it; an older Node keeps the in-memory index.
  if (!sqlite) return t.skip('no node:sqlite in this runtime: the registry keeps the in-memory index');
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE f USING fts5(t, tokenize='unicode61')");
  db.close();
});

test('the SQLite index answers exactly as the in-memory one over the seed places and airports', async (t) => {
  if (!sqlite) return t.skip('no node:sqlite');
  const dir = await tempDir();
  const file = path.join(dir, 'seed.sqlite');
  const { index, built } = await SqlitePlaceIndex.openOrBuild(sqlite, file, 'a'.repeat(64), async () => ENTRIES);
  assert.equal(built, true);
  const memory = new PlaceIndex(ENTRIES);
  assert.equal(index.size, memory.size);
  const queries: Array<[string, Parameters<PlaceIndex['search']>[1]]> = [
    ['Honolulu', {}],
    ['hnl', {}],
    ['PHNL', {}],
    ['oahu', {}],
    ['o', {}],
    ['ma', { limit: 20 }],
    ['new', { limit: 20 }],
    ['san', { limit: 30 }],
    ['sao paulo', {}],
    ['international airport', { limit: 25 }],
    ['kah', { position: { latitude: 21.3, longitude: -157.8 } }],
    ['lon', { position: { latitude: 51.5, longitude: 0 }, limit: 15 }],
    ['city', { kinds: ['city'], limit: 10 }],
    ['zzzz', {}],
    ['  ', {}],
  ];
  for (const [q, opts] of queries)
    assert.deepEqual(
      index.search(q, opts).map((h) => [h.entry.id, h.score, h.match]),
      memory.search(q, opts).map((h) => [h.entry.id, h.score, h.match]),
      `query "${q}"`,
    );
  index.close();

  // Opened again from the same source: not rebuilt. A different source: rebuilt.
  const again = await SqlitePlaceIndex.openOrBuild(sqlite, file, 'a'.repeat(64), async () => {
    throw new Error('must not rebuild');
  });
  assert.equal(again.built, false);
  again.index.close();
  const changed = await SqlitePlaceIndex.openOrBuild(sqlite, file, 'b'.repeat(64), async () => ENTRIES.slice(0, 10));
  assert.equal(changed.built, true);
  assert.equal(changed.index.size, 10);
  changed.index.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('at country scale: 100,000 places build once and answer in milliseconds', async (t) => {
  if (!sqlite) return t.skip('no node:sqlite');
  const dir = await tempDir();
  const syllables = ['ka', 'lo', 'ma', 'ri', 'to', 'na', 'se', 'vi', 'du', 'pe', 'go', 'ha'];
  const entries: PlaceEntry[] = [];
  for (let i = 0; i < 100_000; i++) {
    const name =
      syllables[i % 12]! + syllables[Math.floor(i / 12) % 12]! + syllables[Math.floor(i / 144) % 12]! + ` ${i}`;
    entries.push({
      id: `place:test:${i}`,
      name,
      altNames: [],
      kind: 'city',
      position: { latitude: -60 + (i % 1200) / 10, longitude: -180 + Math.floor(i / 1200) * 0.3 },
      importance: (i % 997) / 997,
    });
  }
  const started = Date.now();
  const { index } = await SqlitePlaceIndex.openOrBuild(
    sqlite,
    path.join(dir, 'big.sqlite'),
    'c'.repeat(64),
    async () => entries,
  );
  const buildMs = Date.now() - started;
  const q0 = Date.now();
  const hits = index.search('kalo', { limit: 10 });
  const exact = index.search('kaloka 12', { limit: 5 }); // entry 12's full name
  const queryMs = Date.now() - q0;
  assert.equal(hits.length, 10);
  assert.ok(
    hits.every((h) => h.entry.name.startsWith('kalo')),
    JSON.stringify(hits.slice(0, 2)),
  );
  assert.equal(exact[0]?.entry.id, 'place:test:12', 'an exact name is found among 100,000');
  assert.ok(buildMs < 60_000, `build ${buildMs} ms`);
  assert.ok(queryMs < 2_000, `queries ${queryMs} ms`);
  t.diagnostic(`100k entries: build ${buildMs} ms, two queries ${queryMs} ms`);
  index.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('several indexes searched as one: the first holding an id wins', async (t) => {
  if (!sqlite) return t.skip('no node:sqlite');
  const a = new PlaceIndex([{ ...ENTRIES[0]!, name: 'First copy' }]);
  const b = new PlaceIndex([ENTRIES[0]!, ENTRIES[1]!]);
  const both = new CompositePlaceSearch([a, b]);
  assert.equal(both.size, 3);
  const hits = both.search(ENTRIES[0]!.name.split(' ')[0]!, { limit: 10 });
  assert.equal(hits.filter((h) => h.entry.id === ENTRIES[0]!.id).length, 1);
});

test('registry: packs are searched through SQLite when it is here, and their index files follow the packs', async (t) => {
  if (!sqlite) return t.skip('no node:sqlite');
  const dir = await tempDir();
  const dataDir = path.join(dir, 'data');
  const reg = new WorldPackRegistry({ dataDir, appVersion: '0.1.0-rc.3' });
  const file = path.join(dir, 'h.worldpack');
  await writeTestPack(file);
  await reg.install(file);
  assert.equal(reg.placeIndexKind, 'sqlite');
  assert.equal(reg.placeIndex().search('Honolulu')[0]?.entry.name, 'Honolulu');
  assert.equal(reg.placeIndex().search('HNL')[0]?.entry.iata, 'HNL');
  const indexFile = path.join(dataDir, 'worldpacks', '.index', 'hawaii-test.sqlite');
  assert.ok((await fs.stat(indexFile)).isFile());
  await reg.remove('hawaii-test');
  await assert.rejects(fs.stat(indexFile), /ENOENT/, 'the index of a removed pack is deleted');
  assert.equal(reg.placeIndex().size, 0);

  const memory = new WorldPackRegistry({
    dataDir: path.join(dir, 'm'),
    appVersion: '0.1.0-rc.3',
    placeIndexBackend: 'memory',
  });
  await memory.install(file);
  assert.equal(memory.placeIndexKind, 'memory');
  assert.equal(memory.placeIndex().search('Honolulu')[0]?.entry.name, 'Honolulu');
  await fs.rm(dir, { recursive: true, force: true });
});
