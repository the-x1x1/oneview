import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaticGazetteer } from '@worldview/query-engine';
import { LateGazetteer } from './gazetteer.js';

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
