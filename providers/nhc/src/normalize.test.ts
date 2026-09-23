import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCurrentStorms, parseHemisphere, stormToDraft } from './normalize.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'nhc');
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const NOW = Date.parse('2026-09-23T04:00:00Z');
const opts = { receivedAt: new Date(NOW).toISOString(), nowMs: NOW };

test('CurrentStorms: two storms admitted in the file’s units, the bad id refused with its reason', () => {
  const r = normalizeCurrentStorms(load('normal.json'), opts);
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.observations.map((o) => o.externalId),
    ['ep162026', 'al092026'],
  );
  assert.deepEqual(r.rejected, [{ index: 2, reason: 'missing or invalid storm id' }]);
  const sample = r.observations[1]!;
  assert.equal(sample.payload['classificationLabel'], 'Hurricane');
  assert.equal(sample.payload['intensityKt'], 105);
  assert.equal(sample.payload['basin'], 'Atlantic');
  assert.equal(sample.payload['advisoryUrl'], 'https://www.nhc.noaa.gov/text/MIATCPAT4.shtml');
  assert.equal(sample.observedAt, '2026-09-23T00:00:00.000Z');
});

test('a storm needs an id, a position and a time that has happened', () => {
  const base = { id: 'al012026', latitudeNumeric: 20, longitudeNumeric: -60, lastUpdate: '2026-09-23T03:00:00Z' };
  assert.equal(typeof stormToDraft(base, opts), 'object');
  assert.equal(stormToDraft({ ...base, lastUpdate: '2026-09-23T06:00:00Z' }, opts), 'lastUpdate in the future');
  assert.equal(stormToDraft({ ...base, latitudeNumeric: 95 }, opts), 'invalid position');
  assert.equal(stormToDraft({ ...base, lastUpdate: 'soon' }, opts), 'missing or invalid lastUpdate');
  // Numeric fields missing: the text ones are read instead.
  const text = stormToDraft(
    { id: 'cp022026', latitude: '17.2N', longitude: '155.1W', lastUpdate: '2026-09-23T03:00:00Z' },
    opts,
  );
  assert.ok(typeof text === 'object' && text.position?.latitude === 17.2 && text.position.longitude === -155.1);
  assert.equal(parseHemisphere('12.0S', 'N', 'S'), -12);
  assert.equal(parseHemisphere('12.0E', 'N', 'S'), undefined, 'a longitude hemisphere is not a latitude');
  assert.equal(normalizeCurrentStorms({ storms: [] }, opts).rejected[0]?.index, -1);
  assert.equal(normalizeCurrentStorms(load('empty.json'), opts).observations.length, 0);
});
