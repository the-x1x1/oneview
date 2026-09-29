import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGeostationary, orbitClass } from './orbit-class.js';

// Mean motions and eccentricities of well-known orbits (rounded, typical published values).
test('orbitClass: the ISS, GPS, a geostationary satellite, Molniya and a transfer orbit', () => {
  assert.equal(orbitClass({ meanMotion: 15.5, eccentricity: 0.0007 }), 'LEO', 'ISS, ~420 km');
  assert.equal(orbitClass({ meanMotion: 14.2, eccentricity: 0.001 }), 'LEO', 'sun-synchronous weather, ~850 km');
  assert.equal(orbitClass({ meanMotion: 2.0056, eccentricity: 0.01 }), 'MEO', 'GPS, ~20,200 km');
  assert.equal(orbitClass({ meanMotion: 1.7, eccentricity: 0.0005 }), 'MEO', 'Galileo, ~23,200 km');
  assert.equal(orbitClass({ meanMotion: 1.0027, eccentricity: 0.0002 }), 'GEO');
  assert.equal(orbitClass({ meanMotion: 2.006, eccentricity: 0.72 }), 'HEO', 'Molniya');
  assert.equal(orbitClass({ meanMotion: 2.25, eccentricity: 0.73 }), 'HEO', 'geostationary transfer');
  assert.equal(orbitClass({ meanMotion: 0.95, eccentricity: 0.001 }), 'beyond-GEO', 'graveyard / beyond');
});

test('orbitClass: the LEO/MEO line is a 2,000 km apogee', () => {
  // 2,000 km circular: a = 8378 km, period 2π √(a³/μ) = 127.2 min → 11.32 rev/day.
  assert.equal(orbitClass({ meanMotion: 11.4, eccentricity: 0 }), 'LEO');
  assert.equal(orbitClass({ meanMotion: 11.25, eccentricity: 0 }), 'MEO');
  // A low perigee does not make an orbit low: 300 × 2,600 km is MEO by apogee.
  assert.equal(orbitClass({ meanMotion: 12.6, eccentricity: 0.14 }), 'MEO');
});

test('orbitClass: nonsense in, nothing out; geostationary only when also near-equatorial', () => {
  assert.equal(orbitClass({ meanMotion: 0, eccentricity: 0 }), undefined);
  assert.equal(orbitClass({ meanMotion: Number.NaN, eccentricity: 0 }), undefined);
  assert.equal(orbitClass({ meanMotion: 15, eccentricity: 1.2 }), undefined);
  assert.equal(isGeostationary({ meanMotion: 1.0027, eccentricity: 0.0002, inclination: 0.03 }), true);
  assert.equal(isGeostationary({ meanMotion: 1.0027, eccentricity: 0.0002, inclination: 7.5 }), false, 'inclined GSO');
});
