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
