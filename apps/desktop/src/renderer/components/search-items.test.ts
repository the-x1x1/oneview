import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaceSearchAnswer, SearchResult } from '@worldview/ipc-contract';
import { ONLINE_ROW_ID, onlinePlaceText, searchList } from './search-items.js';

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
    [street.id, honolulu.id],
    'online places first, no duplicate, no row once answered',
  );
  assert.equal(list.items[0]!.hint, 'OSM');
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

test('onlinePlaceText: the words that say go there are not sent; with nothing after them, nothing is', () => {
  assert.equal(onlinePlaceText('  fly to   Honolulu '), 'Honolulu');
  assert.equal(onlinePlaceText('take me to 221B Baker Street'), '221B Baker Street');
  assert.equal(onlinePlaceText('Go to Kona'), 'Kona');
  assert.equal(onlinePlaceText('zoom over Mauna Kea'), 'Mauna Kea');
  assert.equal(onlinePlaceText('fly to'), '');
  assert.equal(onlinePlaceText('Go To'), '');
  // "fly" alone may be the start of a name, as the query engine reads it.
  assert.equal(onlinePlaceText('fly'), 'fly');
  assert.equal(onlinePlaceText('Flyover Road'), 'Flyover Road');
});

test('searchList: "fly to" alone offers no online row; "fly to X" offers X', () => {
  assert.ok(!searchList({ ...base, text: 'fly to' }).items.some((i) => i.id === ONLINE_ROW_ID));
  const row = searchList({ ...base, text: 'fly to Hilo' }).items.find((i) => i.id === ONLINE_ROW_ID);
  assert.equal(row?.title, 'Search places online for “Hilo”');
  // The answer for "Hilo" belongs to "fly to Hilo" too.
  const answered = searchList({
    ...base,
    text: 'fly to Hilo',
    online: { text: 'Hilo', busy: false, answer: ok([street]) },
  });
  assert.equal(answered.results[0]?.id, street.id);
});

test('searchList: a command or query named outright keeps Enter; a weak match does not', () => {
  const command = (score: number): SearchResult => ({
    kind: 'command',
    id: 'command:view-3d',
    title: 'Switch to 3D',
    subtitle: 'Command',
    source: 'command',
    score,
  });
  assert.equal(searchList({ ...base, text: 'switch to 3D', local: [command(0.9)] }).items[0]?.id, 'command:view-3d');
  const query: SearchResult = { kind: 'query', id: 'query:1', title: 'Earthquakes (3)', source: 'parser', score: 0.9 };
  assert.equal(searchList({ ...base, text: 'earthquakes near Japan', local: [query] }).items[0]?.id, 'query:1');
  // "sw" on the way to "Sweden" matches the command weakly: the online row stays first.
  assert.equal(searchList({ ...base, text: 'sw', local: [command(0.5)] }).items[0]?.id, ONLINE_ROW_ID);
});

test('searchList: a cached online answer does not sit above a command the text names', () => {
  // 2026-10-03 on the laptop: "switch to 3D" sent once to OpenStreetMap (Enter before the local
  // results came) left an answer cached for a day, put first — the next Enter flew to Texas.
  const command: SearchResult = {
    kind: 'command',
    id: 'command:view-3d',
    title: 'Switch to 3D',
    subtitle: 'Command',
    source: 'command',
    score: 0.95,
  };
  const texas: SearchResult = { ...street, id: 'place:osm:n534', title: 'Farm to Market Road 534' };
  const list = searchList({
    ...base,
    text: 'switch to 3D',
    local: [command],
    online: { text: 'switch to 3D', busy: false, answer: ok([texas]) },
  });
  assert.deepEqual(
    list.items.map((i) => i.id),
    [command.id, texas.id],
  );
  // A place search still puts what was asked online first (the "Helsinki" case).
  const places = searchList({
    ...base,
    text: 'baker street',
    local: [aircraft],
    online: { text: 'baker street', busy: false, answer: ok([street]) },
  });
  assert.equal(places.items[0]!.id, street.id);
});

test('searchList: a callsign typed in full selects the aircraft, not an online search', () => {
  // 2026-10-03: "CAL101" + Enter went to OpenStreetMap (British postcodes) while the aircraft,
  // found by its callsign, sat below them.
  const cal: SearchResult = {
    kind: 'object',
    id: 'aircraft:icao24:89916d',
    title: 'CAL101',
    subtitle: 'Aircraft',
    source: 'world-state',
    score: 0.95,
  };
  assert.equal(searchList({ ...base, text: 'CAL101', local: [cal] }).items[0]?.id, cal.id);
  assert.equal(searchList({ ...base, text: 'cal101', local: [{ ...cal, score: 0.7 }] }).items[0]?.id, cal.id);
  const postcode: SearchResult = { ...street, id: 'place:osm:ca10', title: 'CA10 1NN' };
  const cached = searchList({
    ...base,
    text: 'CAL101',
    local: [cal],
    online: { text: 'CAL101', busy: false, answer: ok([postcode]) },
  });
  assert.deepEqual(
    cached.items.map((i) => i.id),
    [cal.id, postcode.id],
  );
  // A weak match on the way to a word is not one: "cal" may be the start of a place.
  assert.equal(searchList({ ...base, text: 'cal', local: [{ ...cal, score: 0.6 }] }).items[0]?.id, ONLINE_ROW_ID);
});

test('a grid reference that cannot be right: no online row, and the footer says what is wrong', () => {
  const bad = searchList({ ...base, text: 'fly to 4RFJ 12345 67890' });
  assert.equal(bad.items.length, 0);
  assert.match(bad.footer, /^MGRS reference not read: The square FJ is not in zone 4R/);
  const ambiguous = searchList({ ...base, text: '18S 585628 4511322' });
  assert.equal(ambiguous.items.length, 0);
  assert.match(ambiguous.footer, /^UTM reference not read: 18S could be latitude band S/);
  // One that reads is a place among the local results; nothing is sent online for it first.
  const read: SearchResult = {
    kind: 'place',
    id: 'coordinate:21.40980,-157.91608',
    title: '4Q FJ 12345 67890 (21.4098° N, 157.9161° W)',
    subtitle: 'Coordinates',
    position: { latitude: 21.4098, longitude: -157.91608 },
    source: 'parser',
    score: 0.95,
  };
  const good = searchList({ ...base, text: '4QFJ1234567890', local: [read] });
  assert.equal(good.items[0]?.id, read.id);
  assert.match(good.footer, /1 results/);
});
