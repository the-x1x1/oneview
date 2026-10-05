import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canIdParts, FAST_PACKET_PGNS, FastPacketAssembler, FieldReader, parseYdRawLine } from './wire.js';
import { decodePgn, type N2kMessage } from './pgns.js';

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'nmea2000-local',
  'stream.ydraw',
);
const LINES = readFileSync(fixture, 'utf8').trim().split('\n');

/*
 * The fixture's values are invented and were checked by decoding the same lines with CANboat's
 * own analyzer (github.com/canboat/canboat `1323d68`, built and run outside this repository;
 * fixtures/nmea2000-local/README.md lists what it reported). Beyond these, 400 random frames of
 * the single-frame PGNs, not-available codes included, were decoded by both: every field agreed
 * (the only difference: a rapid position update without a latitude is dropped here, where
 * CANboat still prints the longitude). No CANboat code is included.
 */

test('CAN identifiers: PDU2 PGNs keep their low byte, PDU1 PGNs give it to the destination', () => {
  // Yacht Devices' manual's example line: 19F51323 is PGN 128275 (Distance Log) from device 35.
  assert.deepEqual(canIdParts(0x19f51323), { priority: 6, pgn: 128275, source: 35, destination: 255 });
  // 129025 from device 3 at priority 2.
  assert.deepEqual(canIdParts(0x09f80103), { priority: 2, pgn: 129025, source: 3, destination: 255 });
  // ISO request (PGN 59904, PDU1) addressed to device 0x23 from 0x01.
  assert.deepEqual(canIdParts(0x18ea2301), { priority: 6, pgn: 59904, source: 1, destination: 0x23 });
});

test('RAW lines: a frame heard on the bus; anything else refused', () => {
  const f = parseYdRawLine('17:33:21.107 R 19F51323 01 2F 30 70 00 2F 30 70')!;
  assert.equal(f.pgn, 128275);
  assert.deepEqual([...f.data], [0x01, 0x2f, 0x30, 0x70, 0x00, 0x2f, 0x30, 0x70]);
  assert.equal(parseYdRawLine('17:33:21.107 R 19F51323 01\r')?.data.length, 1, 'one data byte, CR tolerated');
  assert.equal(parseYdRawLine('17:33:21.107 T 19F51323 01 2F'), undefined, 'one this end sent');
  assert.equal(parseYdRawLine('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A'), undefined);
  assert.equal(parseYdRawLine('17:33:21.107 R 19F51323'), undefined, 'no data');
  assert.equal(parseYdRawLine('17:33:21.107 R 19F51323 01 02 03 04 05 06 07 08 09'), undefined, 'more than 8 bytes');
  assert.equal(parseYdRawLine('17:33:21.107 R FFFFFFFF 01'), undefined, 'not a 29-bit identifier');
});

test('fast packets: put back together in order; a gap, a skipped frame or a new sequence drops the message', () => {
  const frames = LINES.slice(17, 22).map((l) => parseYdRawLine(l)!); // 129038, five frames
  assert.ok(frames.every((f) => f.pgn === 129038 && FAST_PACKET_PGNS.has(f.pgn)));
  const a = new FastPacketAssembler();
  const parts = frames.map((f, i) => a.push(f, 1000 + i));
  assert.deepEqual(parts.slice(0, 4), [undefined, undefined, undefined, undefined]);
  assert.equal(parts[4]?.length, 28);
  assert.equal(a.pending, 0);
  // A frame missing in the middle: nothing comes out.
  const b = new FastPacketAssembler();
  for (const [i, f] of frames.entries()) if (i !== 2) assert.equal(b.push(f, 1000 + i), undefined);
  // Too slow between frames: dropped.
  const c = new FastPacketAssembler(750);
  assert.equal(frames.map((f, i) => c.push(f, i * 1000)).filter(Boolean).length, 0);
  // A new message from the same device starts over.
  const d = new FastPacketAssembler();
  d.push(frames[0]!, 0);
  d.push(frames[1]!, 1);
  for (const [i, f] of frames.entries()) d.push(f, 10 + i);
  assert.equal(d.pending, 0, 'the second complete copy came out');
});

test('field reader: little-endian bit fields; the top codes are "not available"', () => {
  const r = new FieldReader(Uint8Array.from([0xff, 0xff, 0xfd, 0xff, 0xfc, 0xff, 0xff, 0x7f]));
  assert.equal(r.unsigned(0, 16), undefined, '0xFFFF not available');
  assert.equal(r.unsigned(16, 16), undefined, '0xFFFD reserved');
  assert.equal(r.unsigned(32, 16), 65532, '0xFFFC is the largest value');
  assert.equal(r.signed(48, 16), undefined, '0x7FFF not available');
  assert.equal(r.unsigned(0, 2), undefined, '2 bits: 3 not available');
  assert.equal(new FieldReader(Uint8Array.from([0x02])).unsigned(0, 2), 2, '2 bits: 2 is data');
  assert.equal(new FieldReader(Uint8Array.from([0xfe, 0xff])).signed(0, 16), -2);
  assert.equal(
    new FieldReader(Uint8Array.from([0x41, 0x40, 0x42, 0x40, 0x20])).text(0, 5),
    'A@B',
    'trailing @ and spaces trimmed',
  );
  assert.equal(r.raw(60, 8), undefined, 'past the end');
});

test("every message of the fixture, as CANboat's analyzer decodes it", () => {
  const fast = new FastPacketAssembler();
  const decoded: Array<{ pgn: number; source: number; message: N2kMessage | undefined }> = [];
  for (const [i, line] of LINES.entries()) {
    const f = parseYdRawLine(line)!;
    const bytes = FAST_PACKET_PGNS.has(f.pgn) ? fast.push(f, i) : f.data;
    if (bytes) decoded.push({ pgn: f.pgn, source: f.source, message: decodePgn(f.pgn, bytes) });
  }
  assert.equal(decoded.length, 16);
  const by = (pgn: number, n = 0) =>
    decoded.filter((d) => d.pgn === pgn)[n]!.message as unknown as Record<string, unknown>;
  const near = (a: unknown, b: number, tol: number) =>
    assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${a} vs ${b}`);
  // CANboat: Latitude 21.3069123, Longitude -157.8583456.
  assert.deepEqual(by(129025), { kind: 'position', latitude: 21.3069123, longitude: -157.8583456 });
  // COG 123.4 (True), SOG 3.21 — angles carry 1e-4 rad, CANboat prints a tenth of a degree.
  near(by(129026)['courseDeg'], 123.4, 0.006);
  assert.equal(by(129026)['speedMps'], 3.21);
  assert.equal(by(129026)['magnetic'], false);
  // Heading 210.5, Variation 9.7, Reference Magnetic; no deviation.
  near(by(127250)['headingDeg'], 210.5, 0.006);
  near(by(127250)['variationDeg'], 9.7, 0.006);
  assert.equal(by(127250)['magnetic'], true);
  assert.equal(by(127250)['deviationDeg'], undefined);
  assert.deepEqual(by(128267), { kind: 'depth', depthM: 12.34, offsetM: 0.5 });
  assert.deepEqual(by(128259), { kind: 'speed', throughWaterMps: 2.85 });
  // Wind 7.50 at 42.0 apparent; 6.10 at 275.0 true (ground referenced to north).
  assert.equal(by(130306, 0)['reference'], 2);
  near(by(130306, 0)['angleDeg'], 42, 0.006);
  assert.equal(by(130306, 1)['reference'], 0);
  assert.equal(by(130306, 1)['speedMps'], 6.1);
  // Water 18.55, air 22.10, pressure 1.013 bar.
  assert.deepEqual(by(130310), {
    kind: 'environment',
    waterTemperatureC: 18.55,
    airTemperatureC: 22.1,
    pressureHpa: 1013,
  });
  assert.deepEqual(by(130312), { kind: 'environment', waterTemperatureC: 17.25 });
  near(by(130316)['airTemperatureC'], 21.505, 0.006);
  // GNSS: 2026.10.05, 45296.7890 s, 21.3069123 / -157.8583457, GNSS fix, 9 SVs, HDOP 0.90.
  const gnss = by(129029);
  near(gnss['latitude'], 21.30691234567, 1e-9);
  near(gnss['longitude'], -157.85834567891, 1e-9);
  assert.equal(gnss['fixTime'], Date.parse('2026-10-05T12:34:56.789Z'));
  assert.equal(gnss['satellites'], 9);
  assert.equal(gnss['hdop'], 0.9);
  assert.equal(gnss['method'], 1);
  // AIS class A: 366123456, -157.9 / 21.25, high accuracy, time stamp 33, COG 87.5, SOG 6.20, heading 90.
  const a = by(129038);
  assert.equal(a['mmsi'], 366123456);
  assert.equal(a['aisClass'], 'A');
  assert.equal(a['latitude'], 21.25);
  assert.equal(a['longitude'], -157.9);
  assert.equal(a['accuracy'], true);
  assert.equal(a['second'], 33);
  near(a['courseDeg'], 87.5, 0.006);
  assert.equal(a['speedMps'], 6.2);
  near(a['headingDeg'], 90, 0.006);
  assert.equal(a['navStatus'], 0);
  // AIS class B: 338234567, time stamp not available, no heading.
  const b = by(129039);
  assert.equal(b['aisClass'], 'B');
  assert.equal(b['second'], undefined);
  assert.equal(b['headingDeg'], undefined);
  near(b['latitude'], 21.28, 1e-9);
  // Static and voyage data.
  const s = by(129794);
  assert.equal(s['name'], 'PACIFIC TRADER');
  assert.equal(s['callSign'], 'WDX1234');
  assert.equal(s['imo'], 9876543);
  assert.equal(s['shipType'], 70);
  assert.equal(s['destination'], 'HONOLULU');
  assert.equal(s['draughtM'], 9.85);
  near(s['lengthM'], 182.3, 1e-9);
  assert.equal(by(129809)['name'], 'SEA BREEZE');
  assert.equal(by(129810)['callSign'], 'WYZ9876');
  assert.equal(by(129810)['shipType'], 37);
});
