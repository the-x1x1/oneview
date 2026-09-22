import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquisitionMsUtc, isKeyRejection, isLikelyCsv, parseFirmsCsv } from './csv.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'firms');
const body = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

test('VIIRS and MODIS headers parse by column name, not position', () => {
  const viirs = parseFirmsCsv(body('viirs-snpp.csv'))!;
  assert.equal(viirs.total, 8);
  assert.equal(viirs.rows.length, 8);
  assert.deepEqual(viirs.rows[0], {
    latitude: 38.99488,
    longitude: -121.67046,
    frp: 14.53,
    confidence: 'h',
    brightness: 331.62,
    brightnessSecondary: 295.11,
    scan: 0.39,
    track: 0.36,
    daynight: 'N',
    acqDate: '2026-09-21',
    acqTime: '742',
    satellite: 'N',
    instrument: 'VIIRS',
    version: '2.0NRT',
  });
  const modis = parseFirmsCsv(body('modis.csv'))!;
  assert.equal(modis.rows.length, 4);
  assert.equal(modis.rows[0]?.brightness, 345.6);
  assert.equal(modis.rows[0]?.brightnessSecondary, 298.2);
  assert.equal(modis.rows[0]?.confidence, '87');
  const reordered = parseFirmsCsv(
    'frp,acq_time,acq_date,confidence,longitude,latitude\n1.5,45,2026-09-21,n,10.5,-20.25\n',
  )!;
  assert.deepEqual(reordered.rows[0], {
    latitude: -20.25,
    longitude: 10.5,
    frp: 1.5,
    confidence: 'n',
    daynight: '',
    acqDate: '2026-09-21',
    acqTime: '45',
    satellite: '',
    instrument: '',
    version: '',
  });
});

test('GEV parser edge cases: unpadded midnight, truncated rows, invalid hour, header-only, error text', () => {
  assert.equal(acquisitionMsUtc('2026-07-16', '45'), Date.UTC(2026, 6, 16, 0, 45));
  assert.equal(acquisitionMsUtc('2026-07-16', '0'), Date.UTC(2026, 6, 16, 0, 0));
  assert.equal(acquisitionMsUtc('2026-07-16', '1006'), Date.UTC(2026, 6, 16, 10, 6));
  assert.ok(Number.isNaN(acquisitionMsUtc('2026-07-15', '2400')), 'invalid hour must not roll into tomorrow');
  assert.ok(Number.isNaN(acquisitionMsUtc('2026-02-30', '1200')), 'invalid day must not roll over');
  assert.ok(Number.isNaN(acquisitionMsUtc('16/07/2026', '1200')));
  const truncated = parseFirmsCsv('latitude,longitude,acq_date,acq_time,confidence,frp\n30,-97,2026-07-16,1200\n')!;
  assert.equal(truncated.total, 1);
  assert.equal(truncated.rows.length, 0);
  assert.match(truncated.rejected[0]!.reason, /truncated row/);
  assert.deepEqual(parseFirmsCsv('latitude,longitude,acq_date,acq_time,confidence,frp\n'), {
    rows: [],
    total: 0,
    rejected: [],
  });
  assert.equal(parseFirmsCsv('Invalid MAP_KEY'), undefined);
  assert.equal(parseFirmsCsv(body('malformed-html.txt')), undefined);
  assert.equal(parseFirmsCsv(''), undefined);
  assert.equal(isLikelyCsv('\r\nLATITUDE,Longitude,acq_date,acq_time,confidence,frp\r\n'), true);
  assert.equal(isKeyRejection('Invalid MAP_KEY.'), true);
  assert.equal(isKeyRejection('MAP_KEY is expired'), true);
  assert.equal(isKeyRejection('<html>Bad Gateway</html>'), false);
});

test('malformed rows are rejected individually with reasons; CRLF bodies parse', () => {
  const r = parseFirmsCsv(body('malformed-rows.csv').replace(/\n/g, '\r\n'))!;
  assert.equal(r.total, 8);
  assert.equal(r.rows.length, 3, 'confidence "x" and duplicates are the normalizer\'s job');
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    [
      'truncated row (7/14 columns)',
      'invalid coordinates',
      'invalid coordinates',
      'invalid acquisition time 2026-09-21 2400',
      'invalid acquisition time 2026-13-40 742',
    ],
  );
});
