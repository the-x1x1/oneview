import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { repoRoot, startRuntime } from '../helpers/harness.js';

/**
 * The local read-only API on a real Unix socket (ADR-014, docs/cyberdeck M6), with the composed
 * runtime behind it and the example consumer run as a separate process. Linux only.
 */
const run = promisify(execFile);
const onLinux = process.platform === 'linux';
const consumer = path.join(repoRoot, 'tools', 'local-api-client', 'consumer.mjs');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}
const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  );

async function client(apiPath: string, socket: string, user?: string) {
  const cmd = user ? 'su' : process.execPath;
  const args = user
    ? [
        user,
        '-s',
        '/bin/sh',
        '-c',
        `${JSON.stringify(process.execPath)} ${JSON.stringify(consumer)} '${apiPath}' --socket ${JSON.stringify(socket)}`,
      ]
    : [consumer, apiPath, '--socket', socket];
  try {
    const { stdout } = await run(cmd, args, { timeout: 10_000 });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

test(
  'local API: off by default; on, a separate local client reads a bounded set; off again, gone',
  { skip: !onLinux },
  async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-run-'));
    const socket = path.join(runtimeDir, 'worldview', 'api.sock');
    const h = await startRuntime({ platform: 'linux', localApiSocket: socket });
    try {
      assert.equal(await exists(socket), false, 'off by default: no socket');
      const settings = await h.client.request('settings.get', undefined);
      await h.client.request('settings.set', { localApi: { enabled: true } });
      await until(() => h.runtime.localApi?.listening === true, 'the API to listen');

      // Only this user: the folder 0700, the socket 0600, and nothing on any network port.
      assert.equal((await fs.stat(path.dirname(socket))).mode & 0o777, 0o700);
      const st = await fs.lstat(socket);
      assert.ok(st.isSocket());
      assert.equal(st.mode & 0o777, 0o600);

      const index = await client('/v1', socket);
      assert.equal(index.code, 0, index.err);
      const idx = JSON.parse(index.out) as { api: string; version: number; ownPosition: boolean };
      assert.equal(idx.api, 'worldview-local');
      assert.equal(idx.version, 1);
      assert.equal(idx.ownPosition, false);

      const objects = await client('/v1/objects?lat=21.3&lon=-157.9&radiusKm=100&limit=10', socket);
      assert.equal(objects.code, 0, objects.err);
      const page = JSON.parse(objects.out) as { objects: unknown[]; basis: string; recorded: boolean };
      assert.equal(page.basis, 'live');
      assert.ok(page.objects.length <= 10);

      // Refused, and the client says so (exit 1): own position not allowed, a write, too much.
      assert.equal((await client('/v1/own-position', socket)).code, 1);
      assert.equal((await client('/v1/objects?limit=100000', socket)).code, 1);

      // Another user on this computer cannot open the socket at all (run as root: needs a user).
      if (process.getuid?.() === 0) {
        const other = await run('id', ['-u', 'nobody']).then(
          () => 'nobody',
          () => undefined,
        );
        if (other) {
          const denied = await client('/v1', socket, other);
          assert.equal(denied.code, 2, `${denied.out} ${denied.err}`);
          assert.match(denied.err, /may not open the socket|not running|EACCES/);
        }
      }

      // Own position, once separately allowed.
      await h.client.request('settings.set', { localApi: { enabled: true, ownPosition: true } });
      const own = await client('/v1/own-position', socket);
      assert.equal(own.code, 0, own.err);
      assert.equal((JSON.parse(own.out) as { state: string }).state, 'no-source', 'no node plugged in: said so');

      // Turned off: the socket goes, and a client is told WORLDVIEW is not there.
      await h.client.request('settings.set', { localApi: { enabled: false } });
      await until(async () => !(await exists(socket)), 'the socket to go');
      const gone = await client('/v1', socket);
      assert.equal(gone.code, 2);
      assert.match(gone.err, /not running, or its local API is off/);
      void settings;
    } finally {
      await h.dispose();
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  },
);

test(
  'local API: never takes over a path that is not its own socket; too many requests are refused',
  { skip: !onLinux },
  async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-run-'));
    const socket = path.join(runtimeDir, 'worldview', 'api.sock');
    await fs.mkdir(path.dirname(socket), { mode: 0o700 });
    await fs.writeFile(socket, 'not a socket');
    const h = await startRuntime({ platform: 'linux', localApiSocket: socket });
    try {
      await h.client.request('settings.set', { localApi: { enabled: true } });
      await wait(300);
      assert.equal(h.runtime.localApi, undefined, 'refused to start');
      assert.equal(await fs.readFile(socket, 'utf8'), 'not a socket', 'and left the file alone');

      // Another WORLDVIEW answering on the path (a second profile): not taken over either.
      await fs.rm(socket);
      const net = await import('node:net');
      const other = net.createServer((c) => c.end());
      await new Promise<void>((r) => other.listen(socket, r));
      await h.client.request('settings.set', { localApi: { enabled: false } });
      await h.client.request('settings.set', { localApi: { enabled: true } });
      await wait(300);
      assert.equal(h.runtime.localApi, undefined, 'refused: something answers there');
      assert.equal(await exists(socket), true, "and the other one's socket is still there");
      await new Promise<void>((r) => other.close(() => r()));
      await fs.rm(socket, { force: true });

      await h.client.request('settings.set', { localApi: { enabled: false } });
      await h.client.request('settings.set', { localApi: { enabled: true } });
      await until(() => h.runtime.localApi?.listening === true, 'the API to listen');
      const { getJson } = (await import(consumer)) as {
        getJson: (p: string, o: { socketPath: string }) => Promise<{ status: number }>;
      };
      // A write, with a body: answered 405 (the body never read), the connection closed.
      const http = await import('node:http');
      const post = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ socketPath: socket, path: '/v1', method: 'POST' }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ settings: { network: { workOffline: false } } }));
      });
      assert.equal(post.status, 405);
      assert.match(post.body, /read only/);
      const statuses: number[] = [];
      for (let i = 0; i < 125; i++) statuses.push((await getJson('/v1/health', { socketPath: socket })).status);
      assert.equal(statuses.filter((s) => s === 200).length, 119, 'the POST counted too');
      assert.equal(statuses.filter((s) => s === 429).length, 6);
    } finally {
      await h.dispose();
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  },
);

test('local API: not offered off Linux', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-run-'));
  const socket = path.join(runtimeDir, 'worldview', 'api.sock');
  const h = await startRuntime({ platform: 'win32', localApiSocket: socket });
  try {
    await h.client.request('settings.set', { localApi: { enabled: true } });
    await wait(200);
    assert.equal(h.runtime.localApi, undefined);
    assert.equal(await exists(socket), false);
  } finally {
    await h.dispose();
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test('local API: refused when the runtime folder is open to other users', { skip: !onLinux }, async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-run-'));
  await fs.chmod(runtimeDir, 0o777);
  const socket = path.join(runtimeDir, 'worldview', 'api.sock');
  const h = await startRuntime({ platform: 'linux', localApiSocket: socket });
  try {
    await h.client.request('settings.set', { localApi: { enabled: true } });
    await wait(300);
    assert.equal(h.runtime.localApi, undefined);
    assert.equal(await exists(path.dirname(socket)), false, 'nothing made there');
  } finally {
    await h.dispose();
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test(
  'local API: a connection that never finishes its request is dropped within seconds',
  { skip: !onLinux },
  async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-run-'));
    const socket = path.join(runtimeDir, 'worldview', 'api.sock');
    const h = await startRuntime({ platform: 'linux', localApiSocket: socket });
    try {
      await h.client.request('settings.set', { localApi: { enabled: true } });
      await until(() => h.runtime.localApi?.listening === true, 'the API to listen');
      const net = await import('node:net');
      const started = Date.now();
      const closedAfter = await new Promise<number>((resolve) => {
        const c = net.connect(socket, () => c.write('GET /v1 HTTP/1.1\r\nHost: x\r\n')); // never ends its headers
        c.on('data', () => undefined);
        c.on('close', () => resolve(Date.now() - started));
        c.on('error', () => undefined);
      });
      assert.ok(closedAfter < 8000, `closed after ${closedAfter} ms`);
    } finally {
      await h.dispose();
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  },
);
