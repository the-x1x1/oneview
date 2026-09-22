import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeatureCollection } from './geojson.js';
import { airportsFromFeatures, placesFromFeatures } from './place-entries.js';
import { PlaceIndex, normalizePlaceText, placeHitToSearchResult, tokenizePlaceText } from './place-index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function seedIndex(): Promise<PlaceIndex> {
  const places = parseFeatureCollection(
    JSON.parse(await fs.readFile(path.join(root, 'fixtures', 'places', 'seed-places.geojson'), 'utf8')),
  );
  const airports = parseFeatureCollection(
    JSON.parse(await fs.readFile(path.join(root, 'fixtures', 'airports', 'seed-airports.geojson'), 'utf8')),
  );
  assert.ok(places.ok && airports.ok);
  const ix = new PlaceIndex();
  const p = placesFromFeatures(places.collection);
  const a = airportsFromFeatures(airports.collection);
  assert.equal(p.skipped, 0);
  assert.equal(a.skipped, 0);
  ix.add(p.entries);
  ix.add(a.entries);
  return ix;
}

test('place-index: normalization strips case, diacritics, ʻokina and punctuation', () => {
  assert.equal(normalizePlaceText('Haleakalā'), 'haleakala');
  assert.equal(normalizePlaceText('Kīlauea'), 'kilauea');
  assert.equal(normalizePlaceText('Oʻahu'), 'oahu');
  assert.equal(normalizePlaceText("Hawai'i"), 'hawaii');
  assert.equal(normalizePlaceText('São Paulo'), 'sao paulo');
  assert.equal(normalizePlaceText('Washington, D.C.'), 'washington d c');
  assert.deepEqual(tokenizePlaceText('  Kailua-Kona '), ['kailua', 'kona']);
  assert.deepEqual(tokenizePlaceText('   '), []);
});

test('place-index: the seed fixtures answer the required queries', async () => {
  const ix = await seedIndex();
  assert.ok(ix.size >= 120, `seed index has ${ix.size} entries`);
  const top = (q: string) => ix.search(q, { limit: 3 })[0];
  assert.equal(top('Honolulu')?.entry.id, 'place:city:honolulu-hi');
  assert.equal(top('HNL')?.entry.icao, 'PHNL');
  assert.equal(top('HNL')?.match, 'code');
  assert.equal(top('hnl')?.entry.iata, 'HNL');
  assert.equal(top('Oahu')?.entry.name, 'Oʻahu');
  assert.equal(top('Japan')?.entry.id, 'place:country:JP');
  assert.equal(top('Tokyo')?.entry.id, 'place:city:tokyo-jp');
  assert.equal(top('LAX')?.entry.icao, 'KLAX');
  assert.equal(top('Kilauea')?.entry.name, 'Kīlauea');
  assert.equal(top('haleakala')?.entry.name, 'Haleakalā');
  assert.equal(top('Pearl Harbor')?.entry.name, 'Pearl Harbor');
  assert.equal(top('Big Island')?.entry.name, 'Hawaiʻi Island');
  assert.equal(top('Kona')?.entry.name, 'Kailua-Kona');
  assert.equal(top('PHNL')?.entry.iata, 'HNL');
  assert.equal(top('United Kingdom')?.entry.id, 'place:country:GB');
  assert.equal(top('UK')?.entry.id, 'place:country:GB');
});

test('place-index: ranking — exact beats prefix beats token overlap, importance and distance bias break ties', async () => {
  const ix = await seedIndex();
  const hono = ix.search('Hono', { limit: 5 });
  assert.equal(hono[0]?.entry.name, 'Honolulu');
  assert.equal(hono[0]?.match, 'prefix');

  const exact = ix.search('Honolulu');
  assert.equal(exact[0]?.match, 'exact');
  assert.ok(exact[0]!.score > hono[0]!.score);

  // "Airport" alone matches every airport by token; the position bias must lift Honolulu's airport to the top.
  const nearHonolulu = ix.search('airport', { position: { latitude: 21.3, longitude: -157.85 }, limit: 5 });
  assert.equal(nearHonolulu[0]?.entry.iata, 'HNL');
  const nearTokyo = ix.search('airport', { position: { latitude: 35.68, longitude: 139.69 }, limit: 5 });
  assert.ok(['HND', 'NRT'].includes(nearTokyo[0]?.entry.iata ?? ''), nearTokyo[0]?.entry.name);

  // Importance: with no position, a country outranks a same-named city token match.
  const paris = ix.search('Paris');
  assert.equal(paris[0]?.entry.kind, 'city');

  const multi = ix.search('los angeles');
  assert.equal(multi[0]?.entry.name, 'Los Angeles');
  const partial = ix.search('los ang');
  assert.equal(partial[0]?.entry.name, 'Los Angeles');

  assert.deepEqual(ix.search(''), []);
  assert.deepEqual(ix.search('zzzzqqq'), []);
  const kinds = ix.search('Honolulu', { kinds: ['airport'] });
  assert.ok(kinds.every((h) => h.entry.kind === 'airport'));
});

test('place-index: serialization round-trips, merge dedupes by id, SearchResult mapping', async () => {
  const ix = await seedIndex();
  const json = JSON.parse(JSON.stringify(ix.toJSON()));
  const back = PlaceIndex.fromJSON(json);
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.equal(back.index.size, ix.size);
  assert.equal(back.index.search('Honolulu')[0]?.entry.id, 'place:city:honolulu-hi');
  const merged = PlaceIndex.merge([ix, back.index]);
  assert.equal(merged.size, ix.size);
  const bad = PlaceIndex.fromJSON({ formatVersion: 1, entries: [{ id: 'x' }] });
  assert.equal(bad.ok, false);
  const r = placeHitToSearchResult(ix.search('HNL')[0]!);
  assert.equal(r.kind, 'place');
  assert.equal(r.source, 'worldpack');
  assert.match(r.subtitle ?? '', /Airport · HNL · US/);
  assert.equal(r.position?.latitude, 21.32);
});
