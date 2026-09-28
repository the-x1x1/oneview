import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_GAP_MS,
  NOMINATIM_ATTRIBUTION,
  PHOTON_ATTRIBUTION,
  PlaceSearch,
  assertAllowed,
  coordinate,
  nominatimUrl,
  parseNominatim,
  parsePhoton,
  photonUrl,
  usableBounds,
} from './place-search.js';

/**
 * Answers below are invented in the shape of each service's documented format (Nominatim
 * `format=jsonv2`, Photon GeoJSON); nothing here reaches the network.
 */
const NOMINATIM_BERLIN = [
  {
    place_id: 1,
    osm_type: 'relation',
    osm_id: 62422,
    lat: '52.5170365',
    lon: '13.3888599',
    category: 'boundary',
    type: 'administrative',
    addresstype: 'city',
    name: 'Berlin',
    display_name: 'Berlin, Deutschland',
    boundingbox: ['52.3382448', '52.6755087', '13.0883450', '13.7611609'],
    importance: 0.85,
  },
  { osm_type: 'node', osm_id: 5, lat: '', lon: '13.4', name: 'No latitude', display_name: 'No latitude' },
  { osm_type: 'node', osm_id: 6, lat: null, lon: null, name: 'Null island', display_name: 'Null island' },
];

const PHOTON_TYPO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.2944813, 48.8582602] },
      properties: {
        osm_type: 'W',
        osm_id: 5013364,
        osm_key: 'tourism',
        osm_value: 'attraction',
        type: 'house',
        name: 'Eiffel Tower',
        street: 'Avenue Anatole France',
        housenumber: '5',
        city: 'Paris',
        country: 'France',
        extent: [2.2933, 48.859, 2.2956, 48.8576],
      },
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness(answers: Record<string, () => Response | Promise<Response>>, online = true) {
  let t = 1_000_000;
  const calls: Array<{ url: string; ua: string | null; at: number }> = [];
  // A virtual clock: sleepers wake in time order when `settle` pumps them.
  const timers: Array<{ at: number; wake: () => void }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: new Headers(init?.headers).get('User-Agent'), at: t });
    for (const [host, respond] of Object.entries(answers)) if (url.includes(host)) return respond();
    throw new Error('unexpected host');
  }) as typeof fetch;
  let enabled = true;
  const search = new PlaceSearch({
    fetchImpl,
    userAgent: 'WorldView/0.2.0 (desktop; https://github.com/the-x1x1/oneview)',
    isOnline: () => online,
    enabled: () => enabled,
    now: () => t,
    sleep: (ms) => new Promise<void>((wake) => timers.push({ at: t + ms, wake })),
  });
  /** Runs `p` to the end, waking sleepers one at a time, earliest first, with the clock set to their time. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    void p.finally(() => (done = true));
    for (;;) {
      await new Promise((r) => setImmediate(r));
      if (done) return p;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) return p;
      t = Math.max(t, next.at);
      next.wake();
    }
  }
  return {
    search,
    calls,
    settle,
    advance: (ms: number) => (t += ms),
    disable: () => (enabled = false),
  };
}

test('place search: Nominatim first, with an identifying User-Agent; bad coordinates are refused', async () => {
  const h = harness({ 'nominatim.openstreetmap.org': () => json(NOMINATIM_BERLIN) });
  const answer = await h.search.search({ text: '  Berlin ' });
  assert.equal(answer.status, 'ok');
  assert.equal(answer.service, 'nominatim');
  assert.equal(answer.attribution, NOMINATIM_ATTRIBUTION);
  assert.equal(answer.results.length, 1, 'the rows without real coordinates are dropped');
  const berlin = answer.results[0]!;
  assert.equal(berlin.title, 'Berlin');
  assert.equal(berlin.subtitle, 'Deutschland');
  assert.equal(berlin.kind, 'place');
  assert.equal(berlin.source, 'geocoder');
  assert.equal(berlin.id, 'place:osm:r62422');
  assert.deepEqual(berlin.bounds, { west: 13.088345, south: 52.3382448, east: 13.7611609, north: 52.6755087 });
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0]!.url.startsWith('https://nominatim.openstreetmap.org/search?'));
  assert.ok(h.calls[0]!.url.includes('q=Berlin') && h.calls[0]!.url.includes('format=jsonv2'));
  assert.match(h.calls[0]!.ua ?? '', /^WorldView\/\S+ \(/);
});

test('place search: cached, and the same question in flight shares one request', async () => {
  const h = harness({ 'nominatim.openstreetmap.org': () => json(NOMINATIM_BERLIN) });
  const [a, b] = await Promise.all([h.search.search({ text: 'berlin' }), h.search.search({ text: 'Berlin' })]);
  assert.equal(a, b);
  await h.search.search({ text: 'BERLIN' });
  assert.equal(h.calls.length, 1, 'one request for three askings');
  assert.equal(h.search.stats.fromCache, 1);
  h.advance(25 * 3_600_000);
  await h.search.search({ text: 'berlin' });
  assert.equal(h.calls.length, 2, 'asked again after a day');
});

test('place search: at most one request a second to a service, and a pile-up is refused, not queued', async () => {
  const h = harness({ 'nominatim.openstreetmap.org': () => json(NOMINATIM_BERLIN) });
  await h.settle(h.search.search({ text: 'one' }));
  await h.settle(h.search.search({ text: 'two' }));
  assert.ok(h.calls[1]!.at - h.calls[0]!.at >= MIN_GAP_MS, 'the second waited for its turn');
  // Three more at once: two may wait, the third is told to try again.
  const answers = await h.settle(Promise.all(['a1', 'a2', 'a3'].map((text) => h.search.search({ text }))));
  assert.deepEqual(
    answers.map((a) => a.status),
    ['ok', 'ok', 'busy'],
  );
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i]!.at - h.calls[i - 1]!.at >= MIN_GAP_MS);
});

test('place search: nothing from Nominatim, or Nominatim failing, asks Photon', async () => {
  const empty = harness({
    'nominatim.openstreetmap.org': () => json([]),
    'photon.komoot.io': () => json(PHOTON_TYPO),
  });
  const typo = await empty.search.search({ text: 'eifel towr' });
  assert.equal(typo.status, 'ok');
  assert.equal(typo.service, 'photon');
  assert.equal(typo.attribution, PHOTON_ATTRIBUTION);
  const tower = typo.results[0]!;
  assert.equal(tower.title, 'Eiffel Tower');
  assert.equal(tower.subtitle, 'Avenue Anatole France 5, Paris, France');
  assert.equal(tower.bounds, undefined, 'a building-sized box is framed by zoom instead');
  assert.equal(tower.zoom, 17);
  assert.ok(empty.calls[1]!.url.startsWith('https://photon.komoot.io/api/?'));

  const failing = harness({
    'nominatim.openstreetmap.org': () => new Response('slow down', { status: 429 }),
    'photon.komoot.io': () => json(PHOTON_TYPO),
  });
  assert.equal((await failing.search.search({ text: 'eiffel' })).service, 'photon');

  const both = harness({
    'nominatim.openstreetmap.org': () => new Response('', { status: 503 }),
    'photon.komoot.io': () => Promise.reject(new Error('connection reset')),
  });
  const down = await both.search.search({ text: 'anything' });
  assert.equal(down.status, 'unavailable');
  assert.match(down.message ?? '', /gazetteer/);
  await both.search.search({ text: 'anything' });
  assert.equal(both.calls.length, 2, 'a failure is remembered for a while, not asked again at once');
});

test('place search: offline or switched off, nothing is sent', async () => {
  const off = harness({}, false);
  const answer = await off.search.search({ text: 'Berlin' });
  assert.equal(answer.status, 'offline');
  assert.match(answer.message ?? '', /Offline/);
  const h = harness({ 'nominatim.openstreetmap.org': () => json(NOMINATIM_BERLIN) });
  h.disable();
  assert.equal((await h.search.search({ text: 'Berlin' })).status, 'disabled');
  assert.equal((await h.search.search({ text: 'B' })).results.length, 0, 'too short to ask');
  assert.equal(off.calls.length + h.calls.length, 0);
});

test('place search: only the two services, over https; parsers refuse what is not a place list', () => {
  assert.doesNotThrow(() => assertAllowed(nominatimUrl('x', 3)));
  assert.doesNotThrow(() => assertAllowed(photonUrl('x', 3)));
  assert.throws(() => assertAllowed('https://example.org/search?q=x'));
  assert.throws(() => assertAllowed('http://nominatim.openstreetmap.org/search?q=x'));
  assert.throws(() => parseNominatim({ error: 'x' }, 5));
  assert.throws(() => parsePhoton([], 5));
  assert.equal(coordinate('  ', 90), null);
  assert.equal(coordinate(true, 90), null);
  assert.equal(coordinate('91', 90), null);
  assert.equal(coordinate('-33.9', 90), -33.9);
  assert.equal(usableBounds({ west: 10, south: 5, east: 9, north: 6 }), undefined, 'inverted');
  assert.deepEqual(usableBounds({ west: 1, south: 1, east: 2, north: 2 }), { west: 1, south: 1, east: 2, north: 2 });
});

test('place search: Settings can put Photon first, and the two are cached apart', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(new URL(url).hostname);
    return url.includes('photon') ? json(PHOTON_TYPO) : json(NOMINATIM_BERLIN);
  }) as typeof fetch;
  let first: 'nominatim' | 'photon' = 'photon';
  const search = new PlaceSearch({
    fetchImpl,
    userAgent: 'WorldView/test (+https://github.com/the-x1x1/oneview)',
    isOnline: () => true,
    enabled: () => true,
    first: () => first,
    sleep: async () => undefined,
  });
  assert.equal((await search.search({ text: 'eiffel' })).service, 'photon');
  first = 'nominatim';
  assert.equal((await search.search({ text: 'eiffel' })).service, 'nominatim');
  assert.deepEqual(calls, ['photon.komoot.io', 'nominatim.openstreetmap.org']);
});
