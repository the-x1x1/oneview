import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '@worldview/world-model';
import { WorldState } from './index.js';

const obs = (id: string, observedAt: string, lat: number): Observation =>
  ({
    id: `obs:${id}:${observedAt}`,
    providerId: 'adsb-lol',
    externalId: id,
    objectType: 'aircraft',
    observedAt,
    receivedAt: observedAt,
    payload: { callsign: 'T1' },
    position: { latitude: lat, longitude: 0 },
    quality: { complete: true, sourceQuality: 'crowdsourced' },
    provenance: {
      providerId: 'adsb-lol',
      sourceName: 'adsb.lol',
      origin: 'live',
      attribution: 'x',
      receivedAt: observedAt,
    },
  }) as Observation;

test('the very observation an object was built from, handed in again, changes nothing', () => {
  const now = Date.parse('2026-09-23T20:00:30Z');
  const engine = new WorldState({ clock: { now: () => now } as never, flushDelayMs: 0 });
  const a = obs('a1b2c3', '2026-09-23T20:00:00Z', 10);
  engine.ingest([a], { providerId: 'adsb-lol', snapshot: true });
  const first = [...engine.all()].find((o) => o.type === 'aircraft')!;
  const again = engine.ingest([a], { providerId: 'adsb-lol', snapshot: true });
  assert.equal(again.updated, 0, 'not rebuilt');
  assert.equal(again.removed, 0, 'and still in the snapshot');
  assert.equal(
    [...engine.all()].find((o) => o.type === 'aircraft'),
    first,
    'the same object',
  );
  // A copy with the same content is still merged as before (it is a new report as far as the engine knows).
  const copy = { ...a };
  assert.equal(engine.ingest([copy], { providerId: 'adsb-lol', snapshot: true }).updated, 1);
  const moved = obs('a1b2c3', '2026-09-23T20:00:10Z', 10.1);
  engine.ingest([moved], { providerId: 'adsb-lol', snapshot: true });
  assert.equal([...engine.all()].find((o) => o.type === 'aircraft')!.position?.latitude, 10.1);
});
