import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ProviderError } from '@worldview/provider-sdk';
import { createMqtt } from './mqtt-client.js';
import {
  PacketReader,
  PacketType,
  decode,
  encodeConnect,
  encodePingreq,
  encodeSubscribe,
  isValidTopicFilter,
  topicMatches,
} from './mqtt-packets.js';

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Raw bytes of a broker's packets. */
const connack = (code = 0) => Buffer.from([0x20, 2, 0, code]);
const suback = (id: number, codes: number[]) => Buffer.from([0x90, 2 + codes.length, id >> 8, id & 0xff, ...codes]);
const pingresp = () => Buffer.from([0xd0, 0]);
function publish(
  topic: string,
  payload: Buffer,
  opts: { qos?: 0 | 1; retained?: boolean; packetId?: number } = {},
): Buffer {
  const t = Buffer.from(topic, 'utf8');
  const head = [t.length >> 8, t.length & 0xff, ...t];
  const id = opts.qos ? [(opts.packetId ?? 7) >> 8, (opts.packetId ?? 7) & 0xff] : [];
  const body = Buffer.concat([Buffer.from(head), Buffer.from(id), payload]);
  const flags = ((opts.qos ?? 0) << 1) | (opts.retained ? 1 : 0);
  // Remaining length, variable-length encoded.
  const rl: number[] = [];
  let x = body.length;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    rl.push(b);
  } while (x > 0);
  return Buffer.concat([Buffer.from([0x30 | flags, ...rl]), body]);
}

/**
 * A broker on loopback that records what the client sends, answers CONNECT with the
 * configured CONNACK and every SUBSCRIBE with SUBACK, and lets the test push packets.
 */
async function broker(opts: { connackCode?: number; subackCodes?: number[] } = {}) {
  const clients: net.Socket[] = [];
  const received: Array<{ type: number; body: Buffer }> = [];
  const s = net.createServer((sock) => {
    clients.push(sock);
    sock.on('data', (chunk: Buffer) => {
      // Frame the client's packets the plain way; the test only needs type and body.
      let at = 0;
      while (at < chunk.length) {
        const type = chunk[at]! >> 4;
        let len = 0;
        let mult = 1;
        let i = at + 1;
        for (;;) {
          const b = chunk[i++]!;
          len += (b & 0x7f) * mult;
          mult *= 128;
          if ((b & 0x80) === 0) break;
        }
        received.push({ type, body: chunk.subarray(i, i + len) });
        at = i + len;
        if (type === PacketType.CONNECT) sock.write(connack(opts.connackCode ?? 0));
        if (type === PacketType.SUBSCRIBE) {
          const id = (chunk[i]! << 8) | chunk[i + 1]!;
          sock.write(suback(id, opts.subackCodes ?? [0]));
        }
        if (type === PacketType.PINGREQ) sock.write(pingresp());
      }
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  return {
    port,
    clients,
    received,
    close: () =>
      new Promise<void>((r) => {
        for (const c of clients) c.destroy();
        s.close(() => r());
      }),
  };
}

test('mqtt packets: CONNECT/SUBSCRIBE/PINGREQ encode as the specification lays them out; the reader frames across chunks', () => {
  const c = encodeConnect({ clientId: 'wv', keepAliveSeconds: 60, username: 'u', password: 'p' });
  assert.deepEqual(
    [...c],
    [0x10, 20, 0, 4, 77, 81, 84, 84, 4, 0xc2, 0, 60, 0, 2, 119, 118, 0, 1, 117, 0, 1, 112],
    'protocol name, level 4, flags username+password+clean, keep-alive, client id, username, password',
  );
  const sub = encodeSubscribe(1, [{ topic: 'a/+', qos: 1 }]);
  assert.deepEqual([...sub], [0x82, 8, 0, 1, 0, 3, 97, 47, 43, 1]);
  assert.deepEqual([...encodePingreq()], [0xc0, 0]);

  const reader = new PacketReader();
  const big = publish('t', Buffer.alloc(300, 7), { qos: 1, retained: true, packetId: 9 });
  const all = Buffer.concat([connack(0), big, pingresp()]);
  const first = reader.push(new Uint8Array(all.subarray(0, 5)));
  assert.equal(first.length, 1, 'CONNACK complete, PUBLISH not yet');
  const rest = reader.push(new Uint8Array(all.subarray(5)));
  assert.equal(rest.length, 2);
  const p = rest[0]!;
  assert.equal(p.type, 'publish');
  if (p.type === 'publish') {
    assert.equal(p.topic, 't');
    assert.equal(p.qos, 1);
    assert.equal(p.retained, true);
    assert.equal(p.packetId, 9);
    assert.equal(p.payload.byteLength, 300);
  }
  assert.equal(rest[1]!.type, 'pingresp');
  assert.throws(() => decode(0x36, new Uint8Array([0, 1, 97])), /QoS 3/);
  assert.throws(() => new PacketReader().push(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01])), /malformed/);
});

test('mqtt topics: filters validate and match as the specification says', () => {
  assert.ok(isValidTopicFilter('rtl_433/+/events') && isValidTopicFilter('#') && isValidTopicFilter('a/b/#'));
  assert.ok(
    !isValidTopicFilter('a/#/b') && !isValidTopicFilter('a+') && !isValidTopicFilter('') && !isValidTopicFilter('a/b#'),
  );
  assert.ok(topicMatches('rtl_433/+/events', 'rtl_433/pi/events'));
  assert.ok(!topicMatches('rtl_433/+/events', 'rtl_433/pi/x/events'));
  assert.ok(topicMatches('a/#', 'a/b/c') && topicMatches('a/#', 'a'));
  assert.ok(!topicMatches('#', '$SYS/broker') && topicMatches('$SYS/#', '$SYS/broker'));
});

test('mqtt client: connects, subscribes, delivers publishes (QoS 1 acknowledged), drops oversized and flooding messages, closes cleanly', async () => {
  const b = await broker();
  const mqtt = createMqtt({
    allowed: (host) => host === '127.0.0.1',
    resolveSecret: async (key) => (key === 'broker.password' ? 'hunter2' : undefined),
  });
  const messages: Array<{ topic: string; text: string; retained: boolean; qos: number }> = [];
  const closes: string[] = [];
  let opened = 0;
  const handle = await mqtt.connect(
    {
      host: '127.0.0.1',
      port: b.port,
      username: 'wv',
      credential: { key: 'broker.password' },
      subscriptions: [{ topic: 'rtl_433/+/events', qos: 1 }],
      maxPayloadBytes: 64,
      maxMessagesPerSecond: 3,
      keepAliveSeconds: 5,
    },
    {
      onMessage: (topic, payload, meta) =>
        messages.push({ topic, text: new TextDecoder().decode(payload), retained: meta.retained, qos: meta.qos }),
      onOpen: () => opened++,
      onClose: (reason) => closes.push(reason ?? ''),
    },
  );
  assert.equal(opened, 1);
  const connect = b.received.find((p) => p.type === PacketType.CONNECT)!;
  assert.ok(connect.body.includes(Buffer.from('hunter2')), 'the password went to the broker');
  assert.ok(connect.body.includes(Buffer.from('wv')), 'and the username');
  const sub = b.received.find((p) => p.type === PacketType.SUBSCRIBE)!;
  assert.ok(sub.body.includes(Buffer.from('rtl_433/+/events')));

  const client = b.clients[0]!;
  client.write(publish('rtl_433/pi/events', Buffer.from('{"model":"Acurite"}'), { qos: 1, packetId: 42 }));
  client.write(publish('rtl_433/pi/events', Buffer.from('retained'), { retained: true }));
  await until(() => messages.length === 2);
  assert.deepEqual(messages[0], { topic: 'rtl_433/pi/events', text: '{"model":"Acurite"}', retained: false, qos: 1 });
  assert.equal(messages[1]!.retained, true);
  await until(() => b.received.some((p) => p.type === PacketType.PUBACK));
  const puback = b.received.find((p) => p.type === PacketType.PUBACK)!;
  assert.deepEqual([...puback.body], [0, 42], 'QoS 1 acknowledged with its packet id');

  client.write(publish('rtl_433/pi/events', Buffer.alloc(65, 1)));
  client.write(publish('rtl_433/pi/events', Buffer.from('3')));
  client.write(publish('rtl_433/pi/events', Buffer.from('4')));
  client.write(publish('rtl_433/pi/events', Buffer.from('5')));
  await until(() => handle.dropped >= 3);
  assert.equal(
    messages.length,
    3,
    'three a second delivered; the oversized one and the fourth and fifth in the window dropped',
  );
  assert.equal(handle.dropped, 3);

  handle.close();
  await until(() => closes.length === 1);
  assert.deepEqual(closes, ['closed']);
  await until(() => b.received.some((p) => p.type === PacketType.DISCONNECT));
  await b.close();
});

test('mqtt client: refused hosts, ports and filters never connect; a bad password, a refused subscription and a dead broker are typed', async () => {
  const mqtt = createMqtt({ allowed: (host) => host === '127.0.0.1', resolveSecret: async () => undefined });
  const events = { onMessage: () => undefined };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (e) {
      return e instanceof ProviderError ? e.code : String(e);
    }
  };
  assert.equal(
    await code(mqtt.connect({ host: 'broker.example', subscriptions: [{ topic: 'a' }] }, events)),
    'HOST_NOT_ALLOWED',
  );
  assert.equal(
    await code(mqtt.connect({ host: '127.0.0.1', port: 70000, subscriptions: [{ topic: 'a' }] }, events)),
    'HOST_NOT_ALLOWED',
  );
  assert.equal(await code(mqtt.connect({ host: '127.0.0.1', port: 1, subscriptions: [] }, events)), 'MALFORMED');
  assert.equal(
    await code(mqtt.connect({ host: '127.0.0.1', port: 1, subscriptions: [{ topic: 'a/#/b' }] }, events)),
    'MALFORMED',
  );
  assert.equal(
    await code(
      mqtt.connect(
        { host: '127.0.0.1', port: 1, credential: { key: 'missing' }, subscriptions: [{ topic: 'a' }] },
        events,
      ),
    ),
    'OFFLINE',
    'nothing listens on port 1: refused before the credential matters',
  );

  const bad = await broker({ connackCode: 4 });
  assert.equal(
    await code(mqtt.connect({ host: '127.0.0.1', port: bad.port, subscriptions: [{ topic: 'a' }] }, events)),
    'AUTH',
  );
  await bad.close();
  const refused = await broker({ subackCodes: [0x80] });
  assert.equal(
    await code(mqtt.connect({ host: '127.0.0.1', port: refused.port, subscriptions: [{ topic: 'a' }] }, events)),
    'AUTH',
  );
  await refused.close();

  const withSecret = createMqtt({ allowed: () => true, resolveSecret: async () => undefined });
  const ok = await broker();
  assert.equal(
    await code(
      withSecret.connect(
        { host: '127.0.0.1', port: ok.port, credential: { key: 'nope' }, subscriptions: [{ topic: 'a' }] },
        events,
      ),
    ),
    'AUTH',
    'an unconfigured credential never reaches CONNECT',
  );
  assert.ok(!ok.received.some((p) => p.type === PacketType.CONNECT));
  await ok.close();
});
