import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameReader,
  PORT_POSITION,
  PORT_TELEMETRY,
  PORT_TEXT_MESSAGE,
  ProtoError,
  ProtoReader,
  frame,
  heartbeatFrame,
  nodeId,
  readFromRadio,
  readPosition,
  readTelemetry,
  wantConfigFrame,
} from './wire.js';
import {
  concat,
  deviceMetrics,
  environment,
  fromRadio,
  nodeInfo,
  packet,
  pb,
  position,
  telemetry,
  user,
} from '../test/encode.js';

// Every node, name, place and reading here is invented.

test('frames: split across chunks, log text before a frame skipped, a false start passed over', () => {
  const a = frame(Uint8Array.from([1, 2, 3]));
  const b = frame(Uint8Array.from([4]));
  const log = new TextEncoder().encode('INFO  | ??:??:?? 3 [Router] booted\r\n');
  const all = concat(log, a, Uint8Array.from([0x94, 0x00]), b);
  const r = new FrameReader();
  const out: number[][] = [];
  for (let i = 0; i < all.length; i += 5) for (const f of r.push(all.subarray(i, i + 5))) out.push([...f]);
  assert.deepEqual(out, [[1, 2, 3], [4]]);
  assert.equal(r.skipped, log.length + 2, 'the log line and the false start');
});

test('frames: a length over 512 is not a frame; the reader finds the real one after it', () => {
  const r = new FrameReader();
  const bogus = Uint8Array.from([0x94, 0xc3, 0x02, 0x01]); // 513
  const real = frame(Uint8Array.from([9, 9]));
  assert.deepEqual(
    r.push(concat(bogus, real)).map((f) => [...f]),
    [[9, 9]],
  );
  // A partial frame waits for the rest.
  const half = frame(Uint8Array.from([7, 7, 7, 7]));
  assert.deepEqual(r.push(half.subarray(0, 5)), []);
  assert.deepEqual(
    r.push(half.subarray(5)).map((f) => [...f]),
    [[7, 7, 7, 7]],
  );
  assert.throws(() => frame(new Uint8Array(513)), RangeError);
});

test('what is sent: want_config_id and a heartbeat, framed', () => {
  assert.deepEqual([...wantConfigFrame(42)], [0x94, 0xc3, 0x00, 0x02, 0x18, 0x2a]);
  assert.deepEqual([...wantConfigFrame(300)], [0x94, 0xc3, 0x00, 0x03, 0x18, 0xac, 0x02]);
  assert.deepEqual([...heartbeatFrame()], [0x94, 0xc3, 0x00, 0x02, 0x3a, 0x00]);
  assert.equal(nodeId(0x7efeee00), '!7efeee00');
  assert.equal(nodeId(0x1), '!00000001');
});

test('varints: 64-bit values, negative int32 sign-extended to ten bytes, zigzag sint32', () => {
  const r = new ProtoReader(
    Uint8Array.from(pb.msg(pb.varint(1, -42), pb.varint(2, 0xffffffff), pb.sint32(3, -3), pb.varint(4, 2 ** 40))),
  );
  let f = r.next()!;
  assert.equal(r.int32(f.wire), -42);
  f = r.next()!;
  assert.equal(r.uint32(f.wire), 0xffffffff);
  f = r.next()!;
  assert.equal(r.sint32(f.wire), -3);
  f = r.next()!;
  assert.equal(f.field, 4);
  r.skip(f.wire);
  assert.equal(r.next(), undefined);
});

test('a position: 1e-7 degrees, negative altitude, fix time, precision; unknown fields skipped', () => {
  const p = readPosition(
    Uint8Array.from(
      pb.msg(
        position({ lat: -33.8567844, lon: 151.2152967, alt: -12, time: 1_790_000_000, precisionBits: 13 }),
        pb.fixed64(30),
      ),
    ),
  );
  assert.equal(p.latitudeI, -338567844);
  assert.equal(p.longitudeI, 1512152967);
  assert.equal(p.altitudeM, -12);
  assert.equal(p.time, 1_790_000_000);
  assert.equal(p.precisionBits, 13);
});

test('FromRadio: my info, a node from the list, the list complete, a reboot, a config message skipped', () => {
  const read = (bytes: Uint8Array) => readFromRadio(new FrameReader().push(bytes)[0]!);
  assert.deepEqual(read(fromRadio.myInfo(0x7efeee00)), { kind: 'my-info', myNodeNum: 0x7efeee00 });
  const n = read(
    fromRadio.nodeInfo(
      nodeInfo({
        num: 0xa1b2c3d4,
        user: user({ id: '!a1b2c3d4', longName: 'Ridge relay', shortName: 'RDG', hwModel: 43 }),
        position: position({ lat: 21.3069, lon: -157.8583, alt: 610 }),
        snr: 6.25,
        lastHeard: 1_790_000_100,
        device: deviceMetrics({ battery: 87, voltage: 4.05 }),
        hopsAway: 2,
      }),
    ),
  );
  assert.equal(n.kind, 'node-info');
  if (n.kind !== 'node-info') return;
  assert.equal(n.node.num, 0xa1b2c3d4);
  assert.deepEqual(n.node.user, { id: '!a1b2c3d4', longName: 'Ridge relay', shortName: 'RDG', hwModel: 43 });
  assert.equal(n.node.position?.altitudeM, 610);
  assert.equal(n.node.snr, 6.25);
  assert.equal(n.node.device?.batteryLevel, 87);
  assert.ok(Math.abs(n.node.device!.voltage! - 4.05) < 1e-6);
  assert.equal(n.node.hopsAway, 2);
  assert.deepEqual(read(fromRadio.configComplete(77)), { kind: 'config-complete', id: 77 });
  assert.deepEqual(read(fromRadio.rebooted()), { kind: 'rebooted' });
  assert.deepEqual(read(fromRadio.config()), { kind: 'other' });
});

test('a packet: position and telemetry payloads kept for reading; a text message keeps nothing; an encrypted one is marked', () => {
  const read = (bytes: Uint8Array) => {
    const m = readFromRadio(new FrameReader().push(bytes)[0]!);
    assert.equal(m.kind, 'packet');
    return m.kind === 'packet' ? m.packet : undefined!;
  };
  const pos = read(
    fromRadio.packet(
      packet({
        from: 0xa1b2c3d4,
        portnum: PORT_POSITION,
        payload: position({ lat: 1, lon: 2 }),
        rxTime: 5,
        snr: -7.5,
        rssi: -110,
        hopStart: 3,
        hopLimit: 1,
      }),
    ),
  );
  assert.equal(pos.from, 0xa1b2c3d4);
  assert.equal(pos.decoded?.portnum, PORT_POSITION);
  assert.ok(pos.decoded?.payload && pos.decoded.payload.length > 0);
  assert.equal(pos.rxSnr, -7.5);
  assert.equal(pos.rxRssi, -110);
  assert.equal(pos.hopStart, 3);
  assert.equal(pos.hopLimit, 1);

  const words = 'meet at the trailhead at noon';
  const text = read(
    fromRadio.packet(packet({ from: 9, portnum: PORT_TEXT_MESSAGE, payload: [...new TextEncoder().encode(words)] })),
  );
  assert.deepEqual(text.decoded, { portnum: PORT_TEXT_MESSAGE }, 'the words are not kept, not even as bytes');
  assert.ok(!JSON.stringify(text).includes('trailhead'));

  const secret = read(fromRadio.packet(packet({ from: 9, encrypted: true })));
  assert.equal(secret.encrypted, true);
  assert.equal(secret.decoded, undefined);

  const t = readTelemetry(
    Uint8Array.from(
      telemetry({
        time: 10,
        device: deviceMetrics({ battery: 101, chUtil: 12.5, uptime: 3600 }),
        environment: environment({ temperature: 23.5, humidity: 61, pressure: 1013.2 }),
      }),
    ),
  );
  assert.equal(t.device?.batteryLevel, 101);
  assert.equal(t.device?.channelUtilization, 12.5);
  assert.equal(t.environment?.temperatureC, 23.5);
  assert.ok(Math.abs(t.environment!.barometricPressureHpa! - 1013.2) < 1e-3);
  assert.equal(PORT_TELEMETRY, 67);
});

test('a truncated or mistyped message is a ProtoError, never a crash', () => {
  assert.throws(() => readFromRadio(Uint8Array.from([0x12, 0x05, 1, 2])), ProtoError, 'length past the end');
  assert.throws(() => readFromRadio(Uint8Array.from([0x10, 0x80])), ProtoError, 'varint past the end');
  assert.throws(() => readPosition(Uint8Array.from(pb.varint(1, 5))), ProtoError, 'a varint where sfixed32 belongs');
  assert.throws(() => readFromRadio(Uint8Array.from([0x0b])), ProtoError, 'a wire type it cannot step over');
});

/**
 * Bytes encoded by Meshtastic's own generated message code (the Python client's `mesh_pb2` /
 * `telemetry_pb2`, github.com/meshtastic/python at 0a18357, 2026-10-03), run outside this
 * repository — that code is GPL-3.0 and is not included; only these encodings of invented
 * values are. They check the reader against the real field numbers and wire types, not
 * against this repository's own test encoder.
 */
const OFFICIAL = {
  nodeInfo:
    '080222900108d487cb8d0a12430a09216131623263336434120b52696467652072656c61791a03524447282b38024220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f1a1d0dc82cb30c1528bce8a118f4ffffffffffffffff0125803bb16ab8010d250000c8402de43bb16a32140857159a9981401d00004841250000c03f28a038400148025001',
  packetPosition:
    '080b12470dd4c3b2a115ffffffff221d080312190d3021601c15589a15b718383dac3cb16a7803980109b8012035341200003dad3cb16a45000088c04802609bffffffffffffffff017803',
  packetEnvironment: '080c122b0dd4c3b2a115ffffffff221f0843121b0d103db16a1a140dec5190411500009a421dcd4c7d444d00009643',
  packetText: '080f122d0dd4c3b2a115ffffffff22210801121d6d6565742061742074686520747261696c68656164206174206e6f6f6e',
  myInfo: '08011a0e088d98ac5040036a05746265616d',
  configComplete: '080938b2f219',
  wantConfig: '1880b28dd606',
  heartbeat: '3a00',
};
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

test('read as Meshtastic writes it: encodings made by its own generated code', () => {
  const ni = readFromRadio(hex(OFFICIAL.nodeInfo));
  assert.equal(ni.kind, 'node-info');
  if (ni.kind !== 'node-info') return;
  assert.equal(ni.node.num, 0xa1b2c3d4);
  assert.deepEqual(ni.node.user, { id: '!a1b2c3d4', longName: 'Ridge relay', shortName: 'RDG', hwModel: 43, role: 2 });
  assert.deepEqual(ni.node.position, {
    latitudeI: 213069000,
    longitudeI: -1578583000,
    altitudeM: -12,
    time: 1790000000,
    precisionBits: 13,
  });
  assert.equal(ni.node.snr, 6.25);
  assert.equal(ni.node.lastHeard, 1790000100);
  assert.equal(ni.node.device?.batteryLevel, 87);
  assert.equal(ni.node.device?.uptimeSeconds, 7200);
  assert.equal(ni.node.hopsAway, 2);
  assert.equal(ni.node.viaMqtt, true);

  const pp = readFromRadio(hex(OFFICIAL.packetPosition));
  assert.equal(pp.kind, 'packet');
  if (pp.kind !== 'packet') return;
  assert.equal(pp.packet.from, 0xa1b2c3d4);
  assert.equal(pp.packet.rxSnr, -4.25);
  assert.equal(pp.packet.rxRssi, -101);
  assert.equal(pp.packet.hopStart, 3);
  assert.equal(pp.packet.hopLimit, 2);
  assert.deepEqual(readPosition(pp.packet.decoded!.payload!), {
    latitudeI: 476062000,
    longitudeI: -1223321000,
    altitudeM: 56,
    fixTime: 1790000300,
    satsInView: 9,
    precisionBits: 32,
  });

  const pe = readFromRadio(hex(OFFICIAL.packetEnvironment));
  if (pe.kind !== 'packet') return assert.fail('not a packet');
  const env = readTelemetry(pe.packet.decoded!.payload!).environment!;
  assert.ok(Math.abs(env.temperatureC! - 18.04) < 1e-5 && env.relativeHumidity === 77);
  assert.ok(Math.abs(env.barometricPressureHpa! - 1013.2) < 1e-3);

  const pt = readFromRadio(hex(OFFICIAL.packetText));
  if (pt.kind !== 'packet') return assert.fail('not a packet');
  assert.deepEqual(pt.packet.decoded, { portnum: PORT_TEXT_MESSAGE });

  assert.deepEqual(readFromRadio(hex(OFFICIAL.myInfo)), { kind: 'my-info', myNodeNum: 0x0a0b0c0d });
  assert.deepEqual(readFromRadio(hex(OFFICIAL.configComplete)), { kind: 'config-complete', id: 424242 });
  // What is sent is what Meshtastic's own code would send.
  assert.equal(Buffer.from(wantConfigFrame(1791187200).subarray(4)).toString('hex'), OFFICIAL.wantConfig);
  assert.equal(Buffer.from(heartbeatFrame().subarray(4)).toString('hex'), OFFICIAL.heartbeat);
});
