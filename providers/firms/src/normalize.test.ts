import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationSchema, formatIssues } from '@worldview/world-model';
import { parseFirmsCsv } from './csv.js';
import { detectionExternalId, normalizeConfidence, normalizeFirmsRows, rowToDraft } from './normalize.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'firms');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');
const receivedAt = '2026-09-21T08:05:00.000Z';

test('confidence normalizes VIIRS letters and MODIS percentages to one enum', () => {
  assert.equal(normalizeConfidence('l'), 'low');
  assert.equal(normalizeConfidence('N'), 'nominal');
  assert.equal(normalizeConfidence('h'), 'high');
  assert.equal(normalizeConfidence('0'), 'low');
  assert.equal(normalizeConfidence('29'), 'low');
  assert.equal(normalizeConfidence('30'), 'nominal');
  assert.equal(normalizeConfidence('79'), 'nominal');
  assert.equal(normalizeConfidence('80'), 'high');
  assert.equal(normalizeConfidence('100'), 'high');
  assert.equal(normalizeConfidence('101'), undefined);
  assert.equal(normalizeConfidence('x'), undefined);
  assert.equal(normalizeConfidence(''), undefined);
});

test('MODIS rows normalize with numeric confidence bands and 1 km accuracy', () => {
  const parsed = parseFirmsCsv(body('modis.csv'))!;
  const r = normalizeFirmsRows(parsed.rows, { receivedAt, source: 'MODIS_NRT' });
  assert.equal(r.rejected.length, 0);
  assert.deepEqual(r.observations.map((o) => o.payload['confidence']), ['high', 'high', 'nominal', 'low']);
  const o = r.observations[0]!;
  const v = observationSchema.parse(o);
  assert.ok(v.ok, v.ok ? '' : formatIssues(v.issues));
  assert.equal(o.externalId, 'MODIS_NRT:2026-09-21T0610:38.9951:-121.6702');
  assert.equal(o.payload['brightnessK'], 345.6);
  assert.equal(o.payload['brightnessSecondaryK'], 298.2);
  assert.equal(o.payload['satellite'], 'Aqua');
  assert.equal(o.quality.positionAccuracyM, 1000);
  assert.equal(o.provenance.attribution, 'NASA FIRMS');
  assert.equal(o.rawPayloadHash, undefined, 'no hash function → no hash');
});

test('external ids are deterministic per source pixel and minute; duplicates and bad confidence are rejected', () => {
  const row = { latitude: 38.99488, longitude: -121.67046, acqDate: '2026-09-21', acqTime: '742' };
  assert.equal(detectionExternalId('VIIRS_SNPP_NRT', row), 'VIIRS_SNPP_NRT:2026-09-21T0742:38.99488:-121.67046');
  assert.equal(detectionExternalId('VIIRS_SNPP_NRT', { ...row, acqTime: '45' }), 'VIIRS_SNPP_NRT:2026-09-21T0045:38.99488:-121.67046');
  const parsed = parseFirmsCsv(body('malformed-rows.csv'))!;
  const r = normalizeFirmsRows(parsed.rows, { receivedAt, source: 'VIIRS_SNPP_NRT', hash: (s) => 'f'.repeat(63) + String(s.length % 10) });
  assert.equal(r.observations.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['unknown confidence value "x"', 'duplicate detection VIIRS_SNPP_NRT:2026-09-21T0340:-33.6121:150.21044']);
  assert.match(r.observations[0]!.rawPayloadHash!, /^f{63}\d$/);
});

test('observedAt is the UTC acquisition minute; day/night and flags are derived', () => {
  const parsed = parseFirmsCsv(body('viirs-snpp.csv'))!;
  const drafts = parsed.rows.map((row) => rowToDraft(row, { receivedAt, source: 'VIIRS_SNPP_NRT' }));
  assert.ok(drafts.every((d) => typeof d !== 'string'));
  const portugal = drafts.find((d) => typeof d !== 'string' && d.payload['dayNight'] === 'day');
  assert.ok(portugal && typeof portugal !== 'string');
  assert.equal(portugal.observedAt, '2026-09-20T13:21:00.000Z');
  assert.equal(portugal.quality?.flags, undefined, 'high-confidence daytime detections carry no flag');
  const low = drafts.find((d) => typeof d !== 'string' && d.payload['confidence'] === 'low');
  assert.ok(low && typeof low !== 'string' && low.quality?.flags?.includes('low-confidence'));
});
