import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_GAZETTEER_ENTRIES, BuiltinGazetteer } from './builtin-gazetteer.js';
import { CompositeGazetteer, StaticGazetteer, normalizePlaceName, type Gazetteer } from './gazetteer.js';
import { parseCoordinates } from './coordinates.js';
import { isValidBounds, isValidLatLon } from '@worldview/world-model';

test('builtin gazetteer: entries are valid and lookups score deterministically', () => {
  assert.ok(BUILTIN_GAZETTEER_ENTRIES.length >= 80);
  const ids = new Set<string>();
  for (const e of BUILTIN_GAZETTEER_ENTRIES) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(isValidLatLon(e.position.latitude, e.position.longitude), e.id);
    if (e.bounds) assert.ok(isValidBounds(e.bounds), `bounds ${e.id}`);
    if (e.kind === 'country' || e.kind === 'region') assert.ok(e.bounds, `${e.kind} ${e.id} needs bounds`);
    if (e.kind === 'airport')
      assert.ok(
        e.aliases!.some((a) => /^[A-Z]{3}$/.test(a)) && e.aliases!.some((a) => /^[A-Z]{4}$/.test(a)),
        `${e.id} needs IATA+ICAO`,
      );
  }
  const g = new BuiltinGazetteer();
  assert.equal(g.lookup('Honolulu')[0]!.id, 'place:builtin:honolulu');
  assert.equal(g.lookup('honolulu')[0]!.score, 1);
  assert.equal(g.lookup('HNL')[0]!.id, 'airport:iata:HNL');
  assert.equal(g.lookup('phnl')[0]!.id, 'airport:iata:HNL');
  assert.equal(g.lookup('Heathrow')[0]!.id, 'airport:iata:LHR');
  assert.equal(g.lookup('Big Island')[0]!.id, 'place:builtin:hawaii-island');
  assert.equal(g.lookup('New York')[0]!.id, 'iso3166-2:US-NY', 'exact ties break by kind rank (region before city)');
  assert.equal(g.lookup('New York')[1]!.id, 'place:builtin:new-york-city');
  assert.equal(g.lookup('Hono')[0]!.id, 'place:builtin:honolulu');
  assert.equal(g.lookup('Hono')[0]!.score, 0.8);
  assert.equal(g.lookup('Angeles')[0]!.score, 0.7, 'word prefix');
  assert.equal(g.lookup('ngele')[0]!.score, 0.6, 'substring');
  assert.equal(g.lookup('ng').length, 0, 'substring needs 3+ chars');
  assert.equal(g.lookup('Hawaii', { kinds: ['airport'] }).length, 0);
  assert.equal(g.lookup('Reykjavik')[0]!.id, 'place:builtin:reykjavik', 'diacritics are ignored');
  assert.equal(g.lookup('Kīlauea')[0]!.id, 'place:builtin:kilauea');
  assert.equal(g.lookup('').length, 0);
  assert.deepEqual(g.lookup('Japan'), g.lookup('Japan'));
});

test('normalizePlaceName strips diacritics and punctuation', () => {
  assert.equal(normalizePlaceName('  São  Paulo! '), 'sao paulo');
  assert.equal(normalizePlaceName("O'Hare"), 'o hare');
});

test('CompositeGazetteer merges hits by id with the best score', () => {
  const primary: Gazetteer = new StaticGazetteer(
    [
      {
        id: 'place:builtin:honolulu',
        name: 'Honolulu',
        kind: 'city',
        position: { latitude: 21.3, longitude: -157.86 },
        aliases: ['Town'],
      },
    ],
    'primary',
  );
  const composite = new CompositeGazetteer([primary, new BuiltinGazetteer()]);
  const hits = composite.lookup('Town');
  assert.equal(hits[0]!.id, 'place:builtin:honolulu');
  assert.equal(hits[0]!.source, 'primary');
  assert.equal(composite.lookup('Honolulu').filter((h) => h.id === 'place:builtin:honolulu').length, 1);
  assert.equal(composite.lookup('Oahu')[0]!.source, 'builtin');
});

test('parseCoordinates accepts exact forms and declines everything else', () => {
  const ok = (text: string, lat: number, lon: number) => {
    const p = parseCoordinates(text);
    assert.ok(p && p.kind !== 'unsupported', `should parse: ${text}`);
    assert.ok(
      Math.abs(p.latitude - lat) < 1e-3 && Math.abs(p.longitude - lon) < 1e-3,
      `${text} → ${p.latitude},${p.longitude}`,
    );
  };
  ok('21.3,-157.9', 21.3, -157.9);
  ok('21.3 -157.9', 21.3, -157.9);
  ok('21.3; -157.9', 21.3, -157.9);
  ok('N 21.3 W 157.9', 21.3, -157.9);
  ok('W 157.9, N 21.3', 21.3, -157.9);
  ok('21.3°N 157.9°W', 21.3, -157.9);
  ok('21.3N, 157.9W', 21.3, -157.9);
  ok('-33.8688, 151.2093', -33.8688, 151.2093);
  ok('21°18\'25"N 157°51\'30"W', 21.30694, -157.85833);
  ok('21 18 25 N, 157 51 30 W', 21.30694, -157.85833);
  ok("21°18.5'N 157°51'W", 21.30833, -157.85);
  ok("S 33°52' E 151°12'", -33.8667, 151.2);
  for (const bad of [
    '12junk, 34oops',
    '91, 10',
    '10, 181',
    '-40N, 20E',
    '21N, 22N',
    '21.3',
    'Honolulu',
    'a1b2c3',
    '21.3, -157.9, 5',
  ]) {
    assert.equal(parseCoordinates(bad), undefined, `should decline: ${bad}`);
  }
  const mgrs = parseCoordinates('4QFJ1234567890');
  assert.equal(mgrs?.kind, 'unsupported');
  assert.equal(parseCoordinates('4Q 612345 2358765')?.kind, 'unsupported');
});
