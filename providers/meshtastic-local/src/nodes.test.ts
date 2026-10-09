import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NODES, NodeStore, OWN_FIX_FRESH_SECONDS, evaluateOwnFix, precisionMetres } from './nodes.js';
import {
  PORT_NODEINFO,
  PORT_POSITION,
  PORT_TELEMETRY,
  PORT_TEXT_MESSAGE,
  readMeshPacket,
  readNodeInfo,
  readPosition,
} from './wire.js';
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

const pos = (f: Parameters<typeof position>[0]) => readPosition(u8(position(f)));

test('own fix: GPS only when the node says its GPS made it, with age, satellites and accuracy', () => {
  const fix = evaluateOwnFix(
    pos({ lat: 21.3, lon: -157.8, source: 2, fixTime: NOW - 40, fixType: 3, sats: 9, hdop: 150, accuracyMm: 2500 }),
    NOW,
  );
  assert.equal(fix.state, 'fix');
  assert.equal(fix.source, 'own GPS');
  assert.equal(fix.ageSeconds, 40);
  assert.equal(fix.accuracyM, 3.8, '2.5 m × HDOP 1.5 (rounded)');
  assert.equal(fix.text, 'GPS fix (3D, 9 satellites), 40 s old, ±3.8 m');
  // Older firmware gives no source; a GPS timestamp still marks it as a GPS fix.
  assert.equal(evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, fixTime: NOW - 5 }), NOW).state, 'fix');
  // An external GPS attached to the node counts too.
  assert.equal(evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 3, time: NOW }), NOW).source, 'external GPS');
  // No accuracy figure is made up from a DOP alone.
  assert.equal(
    evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 2, fixTime: NOW, hdop: 90 }), NOW).accuracyM,
    undefined,
  );
});

test('own fix: old is STALE (labelled with its age), never quietly current', () => {
  const old = evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 2, fixTime: NOW - OWN_FIX_FRESH_SECONDS - 1 }), NOW);
  assert.equal(old.state, 'stale');
  assert.equal(old.text, 'STALE GPS fix, 5 min old');
  assert.equal(old.latitude, 21.3, 'still drawn where it was, dated by the fix');
  const ahead = evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 2, fixTime: NOW + 3600 }), NOW);
  assert.equal(ahead.state, 'unknown-age', 'never "current" with an age it cannot know');
  assert.equal(ahead.ageSeconds, undefined);
  assert.equal(ahead.clockAhead, true);
  assert.match(ahead.text, /ahead of this computer's clock/);
});

test('own fix: NO FIX has no coordinates — no report, 0/0, fix type "none", no fix time, not from GPS', () => {
  const cases = [
    evaluateOwnFix(undefined, NOW),
    evaluateOwnFix(pos({ lat: 0, lon: 0, source: 2, fixTime: NOW }), NOW),
    evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 2, fixTime: NOW, fixType: 1 }), NOW),
    evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 2 }), NOW),
    evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, time: NOW }), NOW),
  ];
  assert.deepEqual(
    cases.map((c) => c.state),
    ['no-fix', 'no-fix', 'no-fix', 'no-fix', 'not-gnss'],
  );
  for (const c of cases) {
    assert.equal(c.latitude, undefined);
    assert.equal(c.longitude, undefined);
    assert.match(c.text, /^NO FIX/);
  }
});

test('own fix: a fixed position typed into the node is drawn, and says it is not GPS', () => {
  const m = evaluateOwnFix(pos({ lat: 21.3, lon: -157.8, source: 1, time: NOW - 86_400 }), NOW);
  assert.equal(m.state, 'manual');
  assert.equal(m.text, 'fixed position set on the node (not GPS)');
  const store = new NodeStore();
  store.myNodeNum = 7;
  store.nodeInfo(readNodeInfo(u8(nodeInfo({ num: 7, position: position({ lat: 21.3, lon: -157.8, source: 1 }) }))));
  const d = store.draft(7, NOW)!;
  assert.deepEqual(d.payload['ownFix'], { kind: 'set-by-hand', source: 'set by hand' });
  assert.equal(d.quality?.sourceQuality, 'crowdsourced');
  assert.deepEqual(d.quality?.flags, ['position-set-by-hand', 'time-from-receipt']);
});

test("own fix: another node's position is never this computer's; losing the fix takes this node off the map", () => {
  const store = new NodeStore();
  store.myNodeNum = 7;
  store.nodeInfo(readNodeInfo(u8(nodeInfo({ num: 7, user: user({ longName: 'Deck', hwModel: 12 }) }))));
  // A neighbour with a perfect fix.
  store.packet(
    readMeshPacket(
      u8(
        pb.msg(
          pb.fixed32(1, 9),
          pb.fixed32(2, 0xffffffff),
          pb.bytes(
            4,
            pb.msg(
              pb.varint(1, PORT_POSITION),
              pb.bytes(2, position({ lat: 21.4, lon: -157.9, source: 2, fixTime: NOW, fixType: 3 })),
            ),
          ),
        ),
      ),
    ),
    NOW,
  );
  assert.equal(store.ownFix(NOW)!.state, 'no-fix');
  assert.equal(store.draft(7, NOW), undefined);
  assert.equal(store.draft(9, NOW)!.payload['thisNode'], false);
  assert.equal(store.draft(9, NOW)!.payload['ownFix'], null);
  assert.deepEqual(store.ownNode(), { id: '!00000007', name: 'Deck', hardware: 'LilyGO T-Beam S3' });

  // This node gets a fix, then loses it: the old coordinates are not kept as its position.
  store.nodeInfo(
    readNodeInfo(u8(nodeInfo({ num: 7, position: position({ lat: 21.31, lon: -157.81, source: 2, fixTime: NOW }) }))),
  );
  assert.equal(store.draft(7, NOW)!.position?.latitude, 21.31);
  store.nodeInfo(readNodeInfo(u8(nodeInfo({ num: 7, position: position({ lat: 0, lon: 0, source: 2 }) }))));
  assert.equal(store.ownFix(NOW)!.state, 'no-fix');
  assert.equal(store.draft(7, NOW), undefined);
  assert.deepEqual(
    store.drafts(NOW).map((d) => d.externalId),
    ['!00000009'],
  );
});

test('own fix: a position claiming to be from this node but heard over the air or MQTT is ignored', () => {
  const store = new NodeStore();
  store.myNodeNum = 7;
  const own = (extra: Parameters<typeof pb.msg>, lat: number) =>
    readMeshPacket(
      u8(
        pb.msg(
          pb.fixed32(1, 7),
          pb.fixed32(2, 0xffffffff),
          pb.bytes(
            4,
            pb.msg(
              pb.varint(1, PORT_POSITION),
              pb.bytes(2, position({ lat, lon: -157.8, source: 2, fixTime: NOW, fixType: 3 })),
            ),
          ),
          ...extra,
        ),
      ),
    );
  // Its own report: no radio readings.
  assert.equal(store.packet(own([], 21.3), NOW), 7);
  assert.equal(store.ownFix(NOW)!.latitude, 21.3);
  for (const spoof of [
    own([pb.float(8, 6.5)], 40), // an SNR: heard on the radio
    own([pb.varint(12, -90)], 41), // an RSSI
    own([pb.varint(9, 1), pb.varint(15, 3)], 42), // hops taken
    own([pb.varint(14, true)], 43), // via MQTT
  ]) {
    assert.equal(store.packet(spoof, NOW), undefined);
    assert.equal(store.ownFix(NOW)!.latitude, 21.3, 'unchanged');
  }
});
