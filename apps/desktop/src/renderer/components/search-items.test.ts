import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaceSearchAnswer, SearchResult } from '@worldview/ipc-contract';
import { ONLINE_ROW_ID, searchList } from './search-items.js';

// Invented results in the shapes the runtime and main return.
const honolulu: SearchResult = {
  kind: 'place',
  id: 'place:gazetteer:honolulu',
  title: 'Honolulu',
  position: { latitude: 21.3, longitude: -157.85 },
  source: 'local-index',
  score: 1,
};
const aircraft: SearchResult = {
  kind: 'object',
  id: 'aircraft:icao24:abc',
  title: 'UAL1',
  source: 'world-state',
  score: 1,
};
const street: SearchResult = {
  kind: 'place',
  id: 'place:osm:w123',
  title: 'Baker Street',
  subtitle: 'London, United Kingdom',
  position: { latitude: 51.52, longitude: -0.157 },
  zoom: 15,
  source: 'geocoder',
  score: 1,
};
const ok = (results: SearchResult[]): PlaceSearchAnswer => ({
  status: 'ok',
  results,
  attribution: 'Places © OpenStreetMap contributors (ODbL) · search by Nominatim',
  service: 'nominatim',
});

const base = { local: [] as SearchResult[], online: null, offline: false, enabled: true };

test('search list: typing never goes online; the row to ask is first when nothing local is a place', () => {
  const none = searchList({ ...base, text: '221b baker st', local: [aircraft] });
  assert.equal(none.items[0]!.id, ONLINE_ROW_ID, 'Enter asks online');
  assert.equal(none.items[0]!.keepOpen, true, 'the list stays open for the answer');
  assert.match(none.items[0]!.title, /Search places online for “221b baker st”/);
  const gazetteer = searchList({ ...base, text: 'honolulu', local: [honolulu] });
  assert.equal(gazetteer.items[0]!.id, honolulu.id, 'Enter still flies to the gazetteer place');
  assert.equal(gazetteer.items.at(-1)!.id, ONLINE_ROW_ID);
  assert.equal(searchList({ ...base, text: 'h' }).items.length, 0, 'one letter: nothing to ask');
});

test('search list: online places join the list with their attribution in the footer', () => {
  const online = { text: 'baker street', busy: false, answer: ok([street, honolulu]) };
  const list = searchList({ ...base, text: ' baker  street ', local: [honolulu], online });
  assert.deepEqual(
    list.items.map((i) => i.id),
    [honolulu.id, street.id],
    'no duplicate, no row once answered',
  );
  assert.equal(list.items[1]!.hint, 'OSM');
  assert.match(list.footer, /© OpenStreetMap contributors \(ODbL\)/);
  assert.ok(
    list.results.some((r) => r.id === street.id),
    'pickable',
  );
  // A different text: the old answer is not shown for it.
  assert.equal(searchList({ ...base, text: 'paris', online }).items[0]!.id, ONLINE_ROW_ID);
});

test('search list: busy, failed and empty answers say so on the row', () => {
  const text = 'somewhere';
  const busy = searchList({ ...base, text, online: { text, busy: true, answer: null } });
  assert.match(busy.items[0]!.title, /Searching OpenStreetMap/);
  const failed = searchList({
    ...base,
    text,
    online: { text, busy: false, answer: { status: 'busy', results: [], attribution: '', message: 'try again' } },
  });
  assert.match(failed.items[0]!.title, /again/);
  assert.equal(failed.items[0]!.subtitle, 'try again');
  const empty = searchList({ ...base, text, online: { text, busy: false, answer: ok([]) } });
  assert.match(empty.items[0]!.title, /No places online/);
});

test('search list: offline or switched off, no row, and the footer says why', () => {
  const offline = searchList({ ...base, text: 'baker street', offline: true });
  assert.equal(offline.items.length, 0);
  assert.match(offline.footer, /Offline — .*gazetteer/);
  const off = searchList({ ...base, text: 'baker street', enabled: false, local: [aircraft] });
  assert.deepEqual(
    off.items.map((i) => i.id),
    [aircraft.id],
  );
  assert.match(off.footer, /online place search is off/);
});
