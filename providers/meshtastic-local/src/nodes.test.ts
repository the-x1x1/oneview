import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NODES, NodeStore, precisionMetres } from './nodes.js';
import { PORT_NODEINFO, PORT_POSITION, PORT_TELEMETRY, PORT_TEXT_MESSAGE, readNodeInfo } from './wire.js';
import { deviceMetrics, environment, nodeInfo, pb, position, telemetry, user } from '../test/encode.js';

// Every node, name, place and reading here is invented.
const NOW = 1_790_000_000;
const u8 = (part: number[]) => Uint8Array.from(part);

test('a node from the list becomes a sensor where it said it was, named, with its readings', () => {
  const store = new NodeStore();
  store.myNodeNum = 0x0a0b0c0d;
  store.nodeInfo(
    readNodeInfo(
      u8(
        nodeInfo({
          num: 0x0a0b0c0d,
          user: user({ longName: 'Base station', shortName: 'BASE', hwModel: 9 }),
          position: position({ lat: 21.3069, lon: -157.8583, alt: 12, fixTime: NOW - 60 }),
          snr: 0,
          lastHeard: NOW - 30,
          device: deviceMetrics({ battery: 101, voltage: 4.2, chUtil: 3.25, airTx: 0.5, uptime: 7200 }),
        }),
      ),
    ),
  );
  const d = store.draft(0x0a0b0c0d, NOW, 'tcp://127.0.0.1:4403')!;
  assert.equal(d.externalId, '!0a0b0c0d');
  assert.equal(d.objectType, 'sensor');
  assert.equal(d.observedAt, new Date((NOW - 60) * 1000).toISOString(), 'dated at its fix');
  assert.deepEqual(d.position, { latitude: 21.3069, longitude: -157.8583, altitudeM: 12 });
  assert.equal(d.payload['name'], 'Base station');
  assert.equal(d.payload['shortName'], 'BASE');
  assert.equal(d.payload['thisNode'], true);
  assert.equal(d.payload['externalPower'], true, 'battery level 101 is mains power, not 101 %');
  assert.equal(d.payload['batteryPct'], undefined);
  assert.equal(d.payload['voltageV'], 4.2);
  assert.equal(d.payload['channelUtilizationPct'], 3.3);
  assert.equal(d.payload['snrDb'], undefined, 'an SNR of 0 is "not measured" for the node itself');
  assert.equal(d.origin, 'local');
  assert.equal(d.sourceRef, 'tcp://127.0.0.1:4403');
});

test('packets: position, node info and telemetry merge per node; text and other applications are not read', () => {
  const store = new NodeStore();
  const from = 0xa1b2c3d4;
  const pkt = (portnum: number, payload: number[], extra: object = {}) => ({
    from,
    to: 0xffffffff,
    decoded: { portnum, payload: u8(payload) },
    ...extra,
  });
  assert.equal(store.packet(pkt(PORT_TEXT_MESSAGE, [...new TextEncoder().encode('hello')]), NOW), undefined);
  assert.equal(store.size, 0, 'a text message creates no node');
  assert.equal(store.packet({ from, to: 0, encrypted: true }, NOW), undefined, 'an undecrypted packet tells nothing');
  assert.equal(store.packet(pkt(5, [1, 2, 3]), NOW), undefined, 'routing and the rest are skipped');

  assert.equal(
    store.packet(
      pkt(PORT_TELEMETRY, telemetry({ environment: environment({ temperature: 18.04, humidity: 77 }) })),
      NOW,
    ),
    from,
  );
  assert.equal(store.draft(from, NOW), undefined, 'no position yet: nothing to draw');
  store.packet(
    pkt(PORT_POSITION, position({ lat: 47.6062, lon: -122.3321, time: NOW - 10, precisionBits: 13 }), {
      rxSnr: -4.25,
      rxRssi: -101,
      hopStart: 3,
      hopLimit: 2,
    }),
    NOW,
  );
  store.packet(pkt(PORT_NODEINFO, user({ longName: 'Hilltop', shortName: 'HT' })), NOW);
  store.packet(pkt(PORT_TELEMETRY, telemetry({ device: deviceMetrics({ battery: 64 }) })), NOW);
  const d = store.draft(from, NOW)!;
  assert.equal(d.payload['name'], 'Hilltop');
  assert.equal(d.payload['temperatureC'], 18, 'the environment kept when device metrics arrive later');
  assert.equal(d.payload['humidityPct'], 77);
  assert.equal(d.payload['batteryPct'], 64);
  assert.equal(d.payload['snrDb'], -4.2);
  assert.equal(d.payload['rssiDbm'], -101);
  assert.equal(d.payload['hopsAway'], 1);
  assert.equal(d.payload['positionPrecisionM'], 2918, 'a position coarsened to 13 bits is about 2.9 km');
  assert.equal(d.quality?.positionAccuracyM, 2918);
  assert.ok(!JSON.stringify(d).includes('hello'));
});

test('times: a fix without a time takes the hearing, a future time is not believed, a new fix forgets the old time', () => {
  const store = new NodeStore();
  store.packet(
    {
      from: 7,
      to: 0,
      rxTime: NOW - 5,
      decoded: { portnum: PORT_POSITION, payload: u8(position({ lat: 1, lon: 2, time: NOW - 100 })) },
    },
    NOW,
  );
  assert.equal(store.draft(7, NOW)!.observedAt, new Date((NOW - 100) * 1000).toISOString());
  store.packet(
    {
      from: 7,
      to: 0,
      rxTime: NOW - 2,
      decoded: { portnum: PORT_POSITION, payload: u8(position({ lat: 1.1, lon: 2 })) },
    },
    NOW,
  );
  const d = store.draft(7, NOW)!;
  assert.equal(d.observedAt, new Date((NOW - 2) * 1000).toISOString(), 'dated when heard, not at the previous fix');
  assert.deepEqual(d.quality?.flags, ['time-from-receipt']);
  store.packet(
    {
      from: 7,
      to: 0,
      decoded: { portnum: PORT_POSITION, payload: u8(position({ lat: 1.2, lon: 2, time: NOW + 86_400 })) },
    },
    NOW,
  );
  assert.equal(
    store.draft(7, NOW)!.observedAt,
    new Date(NOW * 1000).toISOString(),
    'a clock a day ahead is not believed',
  );
});

test('0/0 is no fix; a name falls back to the short name, then the node id', () => {
  const store = new NodeStore();
  store.packet({ from: 8, to: 0, decoded: { portnum: PORT_POSITION, payload: u8(position({ lat: 0, lon: 0 })) } }, NOW);
  assert.equal(store.draft(8, NOW), undefined);
  store.packet({ from: 8, to: 0, decoded: { portnum: PORT_POSITION, payload: u8(position({ lat: 3, lon: 4 })) } }, NOW);
  assert.equal(store.draft(8, NOW)!.payload['name'], '!00000008');
  assert.equal(store.draft(8, NOW)!.quality?.complete, false);
  store.packet({ from: 8, to: 0, decoded: { portnum: PORT_NODEINFO, payload: u8(user({ shortName: 'X8' })) } }, NOW);
  assert.equal(store.draft(8, NOW)!.payload['name'], 'X8');
  // Out-of-range coordinates are not a position either.
  store.packet(
    {
      from: 9,
      to: 0,
      decoded: { portnum: PORT_POSITION, payload: u8(pb.msg(pb.sfixed32(1, 950_000_000), pb.sfixed32(2, 10))) },
    },
    NOW,
  );
  assert.equal(store.draft(9, NOW), undefined);
});

test('the store forgets the node heard least recently past its cap', () => {
  const store = new NodeStore();
  for (let n = 1; n <= MAX_NODES + 2; n++)
    store.packet(
      { from: n, to: 0, decoded: { portnum: PORT_POSITION, payload: u8(position({ lat: 1, lon: 1 })) } },
      NOW,
    );
  assert.equal(store.size, MAX_NODES);
  assert.equal(store.draft(1, NOW), undefined);
  assert.equal(store.draft(2, NOW), undefined);
  assert.ok(store.draft(3, NOW));
});

test('precision: full or unset is no estimate; fewer bits, a wider circle', () => {
  assert.equal(precisionMetres(undefined), undefined);
  assert.equal(precisionMetres(0), undefined);
  assert.equal(precisionMetres(32), undefined);
  assert.equal(precisionMetres(16), 365);
  assert.equal(precisionMetres(10), 23_345);
});
