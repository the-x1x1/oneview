import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeCredentialStore } from '../../src/deps.js';
import { startRuntime } from '../helpers/harness.js';

/**
 * A registered camera has to survive a restart. It used to look as though it did — the
 * cameras-local provider redrew the marker from its own settings — while the gateway
 * had no registration behind it, so every snapshot and stream failed. These tests pin
 * the two halves: what is written where, and that a restart can serve frames again.
 */

/**
 * Stands in for the desktop's DPAPI-backed CredentialStore: the point is that it
 * outlives one runtime instance, which the harness default (a fresh in-memory store per
 * run) does not. The desktop passes the real one — see apps/desktop/src/main/main.ts.
 */
function persistentCredentials(): RuntimeCredentialStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key); },
    async has(key) { return values.has(key); },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
}

const SNAPSHOT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

function jpegFetch(seen: Array<{ url: string; auth: string | undefined }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    seen.push({ url: String(input), auth: headers.get('authorization') ?? undefined });
    return new Response(SNAPSHOT, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
}

test('cameras: a registered camera is restored into its gateway after a restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cameras-'));
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const credentials = persistentCredentials();
  try {
    const first = await startRuntime({ dataDir, credentials, fetchImpl: jpegFetch(seen) });
    const registration = await first.client.request('camera.register', {
      name: 'Driveway',
      url: 'http://user:s3cret@192.168.1.40/snapshot.jpg',
      position: { latitude: 21.3, longitude: -157.8 },
      headingDegrees: 90,
    });
    assert.equal(registration.gateway, 'direct');
    const before = await first.client.request('camera.snapshot', { cameraId: registration.cameraId });
    assert.equal(before.mimeType, 'image/jpeg');
    await first.runtime.stop();

    // cameras.json carries what the gateway needs; it must not carry the password.
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'cameras.json'), 'utf8')) as { items: Array<Record<string, unknown>> };
    assert.equal(stored.items.length, 1);
    const record = stored.items[0]!;
    assert.equal(record['url'], 'http://192.168.1.40/snapshot.jpg', 'the URL is stored with the login stripped out');
    assert.equal(record['credentialKey'], `camera.${registration.cameraId}.credential`);
    const text = JSON.stringify(stored);
    assert.ok(!text.includes('s3cret') && !text.includes('user:'), 'no credential is written to the camera registry');

    // The provider settings keep the marker, and deliberately no URL.
    const providerSettings = JSON.parse(await fs.readFile(path.join(dataDir, 'provider-settings.json'), 'utf8')) as Record<string, unknown>;
    const settingsText = JSON.stringify(providerSettings);
    assert.ok(settingsText.includes(registration.cameraId) && settingsText.includes('Driveway'));
    assert.ok(!settingsText.includes('192.168.1.40'), 'a camera address is not written into provider settings');
    assert.ok(!settingsText.includes('s3cret'));

    // Second run: same data directory, and the camera works again.
    seen.length = 0;
    const second = await startRuntime({ dataDir, credentials, fetchImpl: jpegFetch(seen) });
    try {
      const list = await second.client.request('camera.list', undefined);
      assert.deepEqual(list.map((c) => c.name), ['Driveway'], 'the gateway knows the camera again');
      const after = await second.client.request('camera.snapshot', { cameraId: registration.cameraId });
      assert.equal(after.mimeType, 'image/jpeg', 'and can still fetch a frame');
      assert.equal(seen[0]?.url, 'http://192.168.1.40/snapshot.jpg');
      assert.ok(seen[0]?.auth?.startsWith('Basic '), 'the stored credential is re-attached from the credential store');
      assert.equal(seen[0]?.auth, `Basic ${Buffer.from('user:s3cret', 'utf8').toString('base64')}`);
    } finally { await second.dispose(); }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('cameras: unregistering removes the record and its stored credential', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cameras-'));
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  try {
    const h = await startRuntime({ dataDir, fetchImpl: jpegFetch(seen) });
    const reg = await h.client.request('camera.register', { name: 'Gate', url: 'http://user:pw@10.0.0.5/video.mjpg' });
    const key = `camera.${reg.cameraId}.credential`;
    assert.equal(await h.runtime.core.credentials.has(key), true);

    await h.client.request('camera.unregister', { cameraId: reg.cameraId });
    assert.deepEqual(await h.client.request('camera.list', undefined), []);
    assert.equal(await h.runtime.core.credentials.has(key), false, 'the credential goes with the camera');
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'cameras.json'), 'utf8')) as { items: unknown[] };
    assert.deepEqual(stored.items, [], 'the registry file is rewritten, not appended to');
    await h.dispose();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('cameras: a hostile camera registry on disk is dropped entry by entry', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cameras-'));
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'cameras.json'), JSON.stringify({
      version: 1,
      items: [
        { id: 'aaaaaaaaaaaa', cameraId: 'aaaaaaaaaaaa', objectId: 'camera:cameras-local:aaaaaaaaaaaa', name: 'Good', url: 'http://10.0.0.9/snapshot.jpg', kind: 'snapshot', registeredAt: '2026-09-21T08:00:00.000Z' },
        { id: 'bbbbbbbbbbbb', cameraId: 'bbbbbbbbbbbb', objectId: 'camera:cameras-local:bbbbbbbbbbbb', name: 'File URL', url: 'file:///etc/passwd', kind: 'snapshot', registeredAt: '2026-09-21T08:00:00.000Z' },
        { id: 'cccccccccccc', cameraId: 'cccccccccccc', objectId: 'camera:cameras-local:cccccccccccc', name: 'Inline creds', url: 'http://u:p@10.0.0.9/snapshot.jpg', kind: 'snapshot', registeredAt: '2026-09-21T08:00:00.000Z' },
        { id: 'not-hex', cameraId: 'not-hex', objectId: 'camera:cameras-local:x', name: 'Bad id', url: 'http://10.0.0.9/a.jpg', kind: 'snapshot', registeredAt: '2026-09-21T08:00:00.000Z' },
        { id: 'dddddddddddd', cameraId: 'dddddddddddd', objectId: 'camera:cameras-local:dddddddddddd', name: 'Bad kind', url: 'http://10.0.0.9/a.jpg', kind: 'websocket', registeredAt: '2026-09-21T08:00:00.000Z' },
      ],
    }), 'utf8');
    const h = await startRuntime({ dataDir });
    try {
      const list = await h.client.request('camera.list', undefined);
      assert.deepEqual(list.map((c) => c.name), ['Good'], 'only the valid entry is restored');
    } finally { await h.dispose(); }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
