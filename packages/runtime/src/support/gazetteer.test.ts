import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaticGazetteer } from '@worldview/query-engine';
import { PlaceIndex } from '@worldview/offline';
import { LateGazetteer, PlaceIndexGazetteer } from './gazetteer.js';

test('a late gazetteer finds nothing near a point until its data has loaded, then answers from it', () => {
  const late = new LateGazetteer();
  const here = { latitude: 19.75, longitude: -155.05 };
  assert.deepEqual(late.nearest(here), []);
  late.set(
    new StaticGazetteer([
      { id: 'hilo', name: 'Hilo', kind: 'city', position: { latitude: 19.7241, longitude: -155.0868 } },
    ]),
  );
  const [hilo] = late.nearest(here);
  assert.equal(hilo?.name, 'Hilo');
  assert.ok(hilo!.distanceM > 4_000 && hilo!.distanceM < 5_000);
  assert.ok(hilo!.bearingDeg > 45 && hilo!.bearingDeg < 60, 'north-east of Hilo');
});

test("a worldpack's places near a point, measured on the ellipsoid, the gazetteer's kinds asked for", () => {
  const entry = {
    id: 'pack:village:waimea',
    name: 'Waimea',
    altNames: [],
    kind: 'city' as const,
    countryCode: 'US',
    position: { latitude: 20.0233, longitude: -155.6717 },
    importance: 0.3,
  };
  const g = new PlaceIndexGazetteer(
    () =>
      new PlaceIndex([
        entry,
        {
          ...entry,
          id: 'pack:airport:mue',
          name: 'Waimea-Kohala Airport',
          kind: 'airport',
          position: { latitude: 20.0013, longitude: -155.6681 },
        },
      ]),
  );
  const [near] = g.nearest({ latitude: 19.95, longitude: -155.6 });
  assert.equal(near?.name, 'Waimea', 'cities by default: the airport is not one');
  assert.equal(near?.source, 'worldpack');
  assert.ok(near!.distanceM > 10_000 && near!.distanceM < 12_000);
  assert.equal(
    g.nearest({ latitude: 19.95, longitude: -155.6 }, { kinds: ['airport'] })[0]?.name,
    'Waimea-Kohala Airport',
  );
  assert.deepEqual(new PlaceIndexGazetteer(() => new PlaceIndex([])).nearest({ latitude: 0, longitude: 0 }), []);
});
