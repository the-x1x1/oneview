import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ProviderError } from '@worldview/provider-sdk';
import { createLocalAccess } from './provider-storage.js';

/** A TCP server on loopback that writes `chunks` to each client, then leaves it open. */
async function server(chunks: string[]): Promise<{ port: number; close(): Promise<void>; clients: net.Socket[] }> {
  const clients: net.Socket[] = [];
  const s = net.createServer((sock) => {
    clients.push(sock);
    for (const c of chunks) sock.write(c);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  return {
    port,
    clients,
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

test('a line stream: lines split on LF (CR dropped), across chunk boundaries; close is reported', async () => {
  const srv = await server(['!AIVDM,1,1,,B,17', '7KQJ5000G?tO`K>RA1wUbN0TKH,0*5C\r\n$GPRMC,1*00\n', 'partial']);
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1', 'localhost'] });
  const lines: string[] = [];
  let closed: string | undefined;
  const h = await access.openLineStream!(
    { host: '127.0.0.1', port: srv.port },
    { onLine: (l) => lines.push(l), onClose: (r) => (closed = r) },
  );
  await until(() => lines.length === 2);
  assert.deepEqual(lines, ['!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C', '$GPRMC,1*00']);
  srv.clients[0]!.destroy();
  await until(() => closed !== undefined);
  assert.equal(closed, 'the device closed the connection');
  assert.equal(h.dropped, 0);
  await srv.close();
});

test('an overlong line is dropped up to its end; past the rate cap lines are dropped and counted', async () => {
  const long = 'x'.repeat(2000);
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
  const srv = await server([`${long}\nok\n`, many]);
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1'], maxLinesPerSecond: 10 });
  const lines: string[] = [];
  const h = await access.openLineStream!({ host: '127.0.0.1', port: srv.port }, { onLine: (l) => lines.push(l) });
  await until(() => lines.length >= 10);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lines[0], 'ok', 'the 2,000-byte line was dropped');
  assert.equal(lines.length, 10, 'ten a second');
  assert.ok(h.dropped >= 11, `dropped ${h.dropped}`);
  h.close();
  await srv.close();
});

test('only loopback in the manifest, or the one named host; nothing listening is OFFLINE', async () => {
  const noLoopback = createLocalAccess({ allowedHosts: ['api.example.org'] });
  await assert.rejects(
    noLoopback.openLineStream!({ host: '127.0.0.1', port: 10110 }, { onLine: () => undefined }),
    (e: unknown) => e instanceof ProviderError && e.code === 'HOST_NOT_ALLOWED',
  );
  const access = createLocalAccess({ allowedHosts: ['127.0.0.1'], trustedHosts: () => ['pi.local'] });
  await assert.rejects(
    access.openLineStream!({ host: '10.0.0.9', port: 10110 }, { onLine: () => undefined }),
    /not loopback or the host named/,
  );
  await assert.rejects(
    access.openLineStream!({ host: '127.0.0.1', port: 0 }, { onLine: () => undefined }),
    /not a TCP port/,
  );
  // A port nothing listens on: grab one and close it.
  const probe = await server([]);
  const free = probe.port;
  await probe.close();
  await assert.rejects(
    access.openLineStream!({ host: '127.0.0.1', port: free }, { onLine: () => undefined }),
    (e: unknown) => e instanceof ProviderError && e.code === 'OFFLINE' && /nothing is listening/.test(e.message),
  );
});
