import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ProviderError } from '@worldview/provider-sdk';
import { createLocalAccess } from './provider-storage.js';

/** A TCP server on loopback that writes `chunks` to each client and records what it is sent. */
async function server(
  chunks: Uint8Array[],
): Promise<{ port: number; close(): Promise<void>; clients: net.Socket[]; received: Buffer[] }> {
  const clients: net.Socket[] = [];
  const received: Buffer[] = [];
  const s = net.createServer((sock) => {
    clients.push(sock);
    sock.on('data', (b: Buffer) => received.push(b));
    for (const c of chunks) sock.write(c);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  return {
    port,
    clients,
    received,
    close: () =>
      new Promise((r) => {
        for (const c of clients) c.destroy();
        s.close(() => r());
      }),
  };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const total = (parts: Uint8Array[]) => parts.reduce((n, p) => n + p.length, 0);

test('a byte stream: bytes in as read, a small write out, the close reported', async () => {
  const srv = await server([Uint8Array.from([0x94, 0xc3, 0x00, 0x02]), Uint8Array.from([0x08, 0x01])]);
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1'] });
  const got: Uint8Array[] = [];
  let closed: string | undefined;
  const h = await access.openByteStream!(
    { host: '127.0.0.1', port: srv.port },
    { onData: (b) => got.push(b), onClose: (r) => (closed = r) },
  );
  await until(() => total(got) === 6);
  assert.deepEqual([...Buffer.concat(got)], [0x94, 0xc3, 0x00, 0x02, 0x08, 0x01]);
  assert.equal(h.write(Uint8Array.from([0x94, 0xc3, 0x00, 0x02, 0x18, 0x2a])), true);
  await until(() => srv.received.length > 0);
  assert.deepEqual([...Buffer.concat(srv.received)], [0x94, 0xc3, 0x00, 0x02, 0x18, 0x2a]);
  srv.clients[0]!.destroy();
  await until(() => closed !== undefined);
  assert.equal(closed, 'the device closed the connection');
  assert.equal(h.write(Uint8Array.from([1])), false, 'nothing is written once closed');
  assert.equal(h.dropped, 0);
  await srv.close();
});

test('a byte stream writes only small messages, and only so many a minute', async () => {
  const srv = await server([]);
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1'], maxWriteBytes: 8, maxWritesPerMinute: 3 });
  const h = await access.openByteStream!({ host: '127.0.0.1', port: srv.port }, { onData: () => undefined });
  assert.equal(h.write(new Uint8Array(9)), false, 'over the size cap');
  assert.equal(h.write(new Uint8Array(0)), false, 'nothing to write');
  assert.equal(h.write(new Uint8Array(8)), true);
  assert.equal(h.write(new Uint8Array(1)), true);
  assert.equal(h.write(new Uint8Array(1)), true);
  assert.equal(h.write(new Uint8Array(1)), false, 'the fourth in a minute');
  await until(() => total(srv.received) === 10);
  h.close();
  await srv.close();
});

test('past the read cap a byte stream drops what the device sends, and counts it', async () => {
  const srv = await server([new Uint8Array(3000).fill(7)]);
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1'], maxBytesPerSecond: 1000 });
  const got: Uint8Array[] = [];
  const h = await access.openByteStream!({ host: '127.0.0.1', port: srv.port }, { onData: (b) => got.push(b) });
  await until(() => total(got) + h.dropped === 3000);
  assert.equal(total(got), 1000);
  assert.equal(h.dropped, 2000);
  h.close();
  await srv.close();
});

test('a byte stream goes only to loopback in the manifest or the one named host; nothing listening is OFFLINE', async () => {
  const noLoopback = createLocalAccess({ allowedHosts: ['api.example.org'] });
  await assert.rejects(
    noLoopback.openByteStream!({ host: '127.0.0.1', port: 4403 }, { onData: () => undefined }),
    (e: unknown) => e instanceof ProviderError && e.code === 'HOST_NOT_ALLOWED',
  );
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1'], trustedHosts: () => ['meshtastic.local'] });
  await assert.rejects(
    access.openByteStream!({ host: '10.0.0.9', port: 4403 }, { onData: () => undefined }),
    /not loopback or the host named/,
  );
  await assert.rejects(
    access.openByteStream!({ host: '127.0.0.1', port: 70000 }, { onData: () => undefined }),
    /not a TCP port/,
  );
  const probe = await server([]);
  const free = probe.port;
  await probe.close();
  await assert.rejects(
    access.openByteStream!({ host: '127.0.0.1', port: free }, { onData: () => undefined }),
    (e: unknown) => e instanceof ProviderError && e.code === 'OFFLINE' && /nothing is listening/.test(e.message),
  );
});
