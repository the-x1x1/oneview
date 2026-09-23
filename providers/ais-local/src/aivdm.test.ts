import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AivdmAssembler, nmeaChecksum, payloadBits, decodeMessage } from './aivdm.js';

// Worked examples from gpsd's "AIVDM/AIVDO protocol decoding" (https://gpsd.gitlab.io/gpsd/AIVDM.html).
const TYPE1 = '!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C';
const TYPE5 = [
  '!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C',
  '!AIVDM,2,2,1,A,88888888880,2*25',
];
const TYPE18 = '!AIVDM,1,1,,A,B52K>;h00Fc>jpUlNV@ikwpUoP06,0*4C';

test('checksums and six-bit armouring', () => {
  assert.equal(nmeaChecksum(TYPE1.slice(1, TYPE1.indexOf('*'))), 0x5c);
  const bits = payloadBits('1', 0)!;
  assert.deepEqual([...bits], [0, 0, 0, 0, 0, 1], "'1' is 1");
  assert.deepEqual([...payloadBits('w', 0)!], [1, 1, 1, 1, 1, 1], "'w' is 63");
  assert.equal(payloadBits('1', 6), undefined);
  assert.equal(decodeMessage(new Uint8Array(10)), 'payload too short');
});

test('a Class A position report decodes to gpsd’s figures', () => {
  const r = new AivdmAssembler().push(TYPE1, 0);
  assert.equal(r.kind, 'message');
  if (r.kind !== 'message') return;
  assert.equal(r.channel, 'B');
  assert.equal(r.own, false);
  assert.deepEqual(r.message, {
    type: 1,
    mmsi: 477553000,
    navStatus: 5,
    rateOfTurn: 0,
    accuracy: false,
    // gpsd prints -122.345832; the raw value is -73 407 500 / 600 000 = -122.3458333…, rounded here.
    longitude: -122.345833,
    latitude: 47.582833,
    speedKnots: 0,
    courseDeg: 51,
    headingDeg: 181,
    second: 15,
  });
});

test('a two-sentence static report is assembled: EVER DIADEM, bound for NEW YORK', () => {
  const a = new AivdmAssembler();
  assert.deepEqual(a.push(TYPE5[0]!, 0), { kind: 'fragment' });
  const r = a.push(TYPE5[1]!, 500);
  assert.equal(r.kind, 'message');
  if (r.kind !== 'message') return;
  assert.deepEqual(r.message, {
    type: 5,
    mmsi: 351759000,
    imo: 9134270,
    callSign: '3FOF8',
    shipName: 'EVER DIADEM',
    shipType: 70,
    dimensions: { toBow: 225, toStern: 70, toPort: 1, toStarboard: 31 },
    eta: { month: 5, day: 15, hour: 14, minute: 0 },
    draughtM: 12.2,
    destination: 'NEW YORK',
  });
});

test('a Class B position report', () => {
  const r = new AivdmAssembler().push(TYPE18, 0);
  assert.equal(r.kind, 'message');
  if (r.kind !== 'message') return;
  assert.equal(r.message.type, 18);
  assert.equal(r.message.mmsi, 338087471);
  if (r.message.type !== 18) return;
  assert.equal(r.message.longitude, -74.072132);
  assert.equal(r.message.latitude, 40.68454);
  assert.equal(r.message.speedKnots, 0.1);
  assert.equal(r.message.courseDeg, 79.6);
  assert.equal(r.message.headingDeg, undefined, '511: not available');
  assert.equal(r.message.second, 49);
});

test('what is refused, and what is only ignored', () => {
  const a = new AivdmAssembler();
  assert.deepEqual(a.push(TYPE1.replace('*5C', '*5D'), 0), { kind: 'invalid', reason: 'checksum mismatch' });
  assert.equal(a.push('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A', 0).kind, 'ignored');
  assert.equal(a.push('hello', 0).kind, 'ignored');
  assert.equal(a.push('', 0).kind, 'ignored');
  assert.deepEqual(a.push(TYPE5[1]!, 0), { kind: 'invalid', reason: 'fragment out of order' });
  assert.deepEqual(a.push(TYPE5[0]!, 0), { kind: 'fragment' });
  assert.deepEqual(
    a.push(TYPE5[1]!, 20_000),
    { kind: 'invalid', reason: 'fragment out of order' },
    'expired after 10 s',
  );
  const tagged = `\\s:rcv1,c:1790193600*5B\\${TYPE1}`;
  assert.equal(a.push(tagged, 0).kind, 'message', 'an NMEA 4.0 tag block is skipped');
  assert.equal(
    a.push(
      TYPE1.replace('!AIVDM', '!AIVDO').replace(
        '*5C',
        `*${(0x5c ^ ('M'.charCodeAt(0) ^ 'O'.charCodeAt(0))).toString(16).toUpperCase()}`,
      ),
      0,
    ).kind,
    'message',
  );
});
