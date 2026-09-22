import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, Observation } from '@worldview/world-model';
import { defaultIdentityResolver } from './index.js';

/**
 * ADR-011: every authoritative rule must be proven not to merge two different real
 * things. These tests are the false-merge guard for the `airport` rule.
 */
function airportObservation(providerId: string, externalId: string, payload: Record<string, JsonValue>): Observation {
  return {
    id: `${providerId}:${externalId}:2026-09-01T00:00:00.000Z`,
    providerId,
    externalId,
    objectType: 'airport',
    observedAt: '2026-09-01T00:00:00.000Z',
    receivedAt: '2026-09-01T00:00:00.000Z',
    payload,
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: { providerId, sourceName: providerId, origin: 'local', receivedAt: '2026-09-01T00:00:00.000Z' },
  };
}

test('airport identity: a valid ICAO code is authoritative and joins across providers', () => {
  const a = defaultIdentityResolver.resolve(
    airportObservation('worldview-seed-airports', 'PHNL', {
      icao: 'PHNL',
      name: 'Daniel K. Inouye International Airport',
    }),
  );
  const b = defaultIdentityResolver.resolve(
    airportObservation('some-other-airport-source', 'HNL', { icao: 'phnl', name: 'Honolulu Intl' }),
  );
  assert.equal(a.objectId, 'airport:icao:PHNL');
  assert.equal(a.rule, 'airport.icao');
  assert.equal(a.authoritative, true);
  assert.equal(b.objectId, a.objectId, 'the same ICAO from a different provider is the same airport');
});

test('airport identity: two different airports never merge (ADR-011 false-merge guard)', () => {
  const hnl = defaultIdentityResolver.resolve(
    airportObservation('worldview-seed-airports', 'PHNL', { icao: 'PHNL', name: 'Honolulu' }),
  );
  const ogg = defaultIdentityResolver.resolve(
    airportObservation('worldview-seed-airports', 'PHOG', { icao: 'PHOG', name: 'Kahului' }),
  );
  assert.notEqual(hnl.objectId, ogg.objectId);

  // Same display name, same municipality, same country — nothing but the code decides identity.
  const londonCity = defaultIdentityResolver.resolve(
    airportObservation('p', 'EGLC', { icao: 'EGLC', name: 'London', municipality: 'London', countryCode: 'GB' }),
  );
  const heathrow = defaultIdentityResolver.resolve(
    airportObservation('p', 'EGLL', { icao: 'EGLL', name: 'London', municipality: 'London', countryCode: 'GB' }),
  );
  assert.notEqual(londonCity.objectId, heathrow.objectId);

  // Identical coordinates must not merge either: only the ICAO code is consulted.
  const x = defaultIdentityResolver.resolve(airportObservation('p', 'KAAA', { icao: 'KAAA' }));
  const y = defaultIdentityResolver.resolve(airportObservation('p', 'KBBB', { icao: 'KBBB' }));
  assert.notEqual(x.objectId, y.objectId);
});

test('airport identity: missing or invalid ICAO falls back to a provider-scoped id', () => {
  const missing = defaultIdentityResolver.resolve(
    airportObservation('acme-airports', 'A-1', { name: 'Unnamed strip' }),
  );
  assert.equal(missing.objectId, 'airport:acme-airports:A-1');
  assert.equal(missing.rule, 'provider-scoped');
  assert.equal(missing.authoritative, false);

  // Local/FAA style identifiers with digits are not ICAO location indicators.
  for (const bad of ['K7A8', 'PH', 'PHNLX', '    ', '1234']) {
    const r = defaultIdentityResolver.resolve(airportObservation('acme-airports', 'A-2', { icao: bad }));
    assert.equal(r.rule, 'provider-scoped', `"${bad}" must not be treated as an ICAO code`);
    assert.equal(r.objectId, 'airport:acme-airports:A-2');
  }

  // Two providers that both lack an ICAO code stay separate objects.
  const p1 = defaultIdentityResolver.resolve(airportObservation('source-one', 'X1', { name: 'Strip' }));
  const p2 = defaultIdentityResolver.resolve(airportObservation('source-two', 'X1', { name: 'Strip' }));
  assert.notEqual(p1.objectId, p2.objectId);
});
