import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialStore,
  CredentialStoreError,
  INSECURE_LINUX_BACKENDS,
  encryptionUnavailableReason,
  type SafeStorageLike,
} from './credential-store.js';

/**
 * Linux: Electron's safeStorage can be "available" on top of Chromium's basic_text fallback,
 * whose key is a constant in Chromium. WORLDVIEW must treat that as no secure storage at all.
 */
function linuxSafeStorage(backend: string | undefined, available = true): SafeStorageLike {
  const key = 0x33;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ key)),
    decryptString: (buf) => Buffer.from(buf.map((b) => b ^ key)).toString('utf8'),
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  };
}

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-cred-linux-'));
  return path.join(dir, 'credentials.json');
}

for (const backend of ['basic_text', 'unknown']) {
  test(`credential store (linux): the ${backend} backend is refused even when Electron says encryption is available`, async () => {
    const file = await tempFile();
    const store = new CredentialStore({ file, safeStorage: linuxSafeStorage(backend), platform: 'linux' });
    assert.equal(store.encryptionAvailable, false);
    assert.equal(store.storageBackend, backend);
    await assert.rejects(
      store.set('firms.mapKey', 'secret'),
      (e: CredentialStoreError) => e.code === 'ENCRYPTION_UNAVAILABLE',
    );
    await assert.rejects(fs.access(file), 'nothing is written, not even ciphertext');
    assert.match(store.unavailableReason(), new RegExp(`"${backend}"`));
    assert.match(store.unavailableReason(), /GNOME Keyring or KWallet/);
  });
}

test('credential store (linux): an Electron that does not report its backend is refused', async () => {
  const store = new CredentialStore({
    file: await tempFile(),
    safeStorage: linuxSafeStorage(undefined),
    platform: 'linux',
  });
  assert.equal(store.encryptionAvailable, false);
  assert.equal(store.storageBackend, undefined);
});

test('credential store (linux): a backend that throws is treated as unavailable, never as available', async () => {
  const safe: SafeStorageLike = {
    ...linuxSafeStorage('gnome_libsecret'),
    getSelectedStorageBackend: () => {
      throw new Error('called before app ready');
    },
  };
  const store = new CredentialStore({ file: await tempFile(), safeStorage: safe, platform: 'linux' });
  assert.equal(store.encryptionAvailable, false);
});

for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
  test(`credential store (linux): ${backend} stores and reads back, ciphertext only`, async () => {
    const file = await tempFile();
    const store = new CredentialStore({ file, safeStorage: linuxSafeStorage(backend), platform: 'linux' });
    assert.equal(store.encryptionAvailable, true);
    await store.set('firms.mapKey', 'my-secret-map-key');
    assert.equal(await store.get('firms.mapKey'), 'my-secret-map-key');
    assert.ok(!(await fs.readFile(file, 'utf8')).includes('my-secret-map-key'));
  });
}

test('credential store (linux): Electron unavailable wins over a good backend', async () => {
  const store = new CredentialStore({
    file: await tempFile(),
    safeStorage: linuxSafeStorage('gnome_libsecret', false),
    platform: 'linux',
  });
  assert.equal(store.encryptionAvailable, false);
});

test('credential store: the backend check is Linux-only (Windows DPAPI and macOS Keychain have no such fallback)', async () => {
  for (const platform of ['win32', 'darwin']) {
    const store = new CredentialStore({
      file: await tempFile(),
      safeStorage: linuxSafeStorage('basic_text'),
      platform,
    });
    assert.equal(store.encryptionAvailable, true, platform);
    assert.equal(store.storageBackend, undefined, platform);
  }
});

test('credential store: the file is owner-only on POSIX', { skip: process.platform === 'win32' }, async () => {
  const file = await tempFile();
  const store = new CredentialStore({ file, safeStorage: linuxSafeStorage('gnome_libsecret'), platform: 'linux' });
  await store.set('firms.mapKey', 'secret');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await store.set('other.key', 'secret');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'still 0600 after a rewrite');
});

test('encryptionUnavailableReason names the fix for each platform', () => {
  assert.deepEqual([...INSECURE_LINUX_BACKENDS].sort(), ['basic_text', 'unknown']);
  assert.match(encryptionUnavailableReason('linux', 'basic_text'), /Secret Service/);
  assert.match(encryptionUnavailableReason('linux', 'gnome_libsecret'), /Secret Service/);
  assert.match(encryptionUnavailableReason('win32', undefined), /DPAPI/);
});
