import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VAULT_MARKER_FILE,
  VAULT_PACKS_DIR,
  VaultMonitor,
  initVault,
  nodeVaultFs,
  probeVault,
  vaultPacksDir,
  vaultPathProblem,
  vaultReadable,
  vaultWritable,
  type VaultFs,
} from './vault.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wv-vault-'));
}

async function listing(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

test('initVault: marks an existing folder, creates worldpacks/, and adopts the same vault when added again', async () => {
  const drive = await tmp();
  const r = await initVault(drive, 'Field SSD', { now: () => Date.parse('2026-10-08T00:00:00Z') });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.adopted, false);
  assert.match(r.vault.id, /^[0-9a-f]{32}$/);
  assert.equal(r.vault.label, 'Field SSD');
  assert.deepEqual(await listing(drive), [VAULT_MARKER_FILE, VAULT_PACKS_DIR].sort());
  const again = await initVault(drive, 'renamed');
  assert.ok(again.ok && again.adopted && again.vault.id === r.vault.id && again.vault.label === 'Field SSD');
});

test('initVault never creates the folder: an unmounted mount point that is gone stays gone', async () => {
  const parent = await tmp();
  const missing = path.join(parent, 'media', 'ssd');
  const r = await initVault(missing, 'SSD');
  assert.equal(r.ok, false);
  assert.deepEqual(await listing(parent), [], 'nothing written anywhere');
});

test('vaultPathProblem: relative paths, drive roots and the app folder are refused', () => {
  assert.match(vaultPathProblem('relative/dir') ?? '', /absolute/);
  assert.match(vaultPathProblem(path.parse(process.cwd()).root) ?? '', /drive root/);
  const app = path.join(os.tmpdir(), 'app-data');
  assert.match(vaultPathProblem(path.join(app, 'packs'), app) ?? '', /inside WorldView/);
  assert.match(vaultPathProblem(app, app) ?? '', /inside WorldView/);
  assert.match(vaultPathProblem(os.tmpdir(), app) ?? '', /contain WorldView/);
  assert.equal(vaultPathProblem(path.join(os.tmpdir(), 'ssd'), app), undefined);
});

test('probeVault: ready, then absent when the drive is pulled, and the empty mount point is never written', async () => {
  const drive = await tmp();
  const r = await initVault(drive, 'SSD');
  assert.ok(r.ok);
  if (!r.ok) return;
  const ready = await probeVault(r.vault, { probeWrite: true, lowSpaceBytes: 0 });
  assert.equal(ready.state, 'ready', ready.message);
  assert.deepEqual(await listing(drive), [VAULT_MARKER_FILE, VAULT_PACKS_DIR].sort(), 'the write probe cleaned up');

  // Pulled: the folder is gone.
  const elsewhere = `${drive}-unplugged`;
  await fs.rename(drive, elsewhere);
  const gone = await probeVault(r.vault, { probeWrite: true });
  assert.equal(gone.state, 'absent');
  assert.match(gone.message, /not connected/);

  // Unmounted: the mount point is an empty folder on the internal disk.
  await fs.mkdir(drive);
  const empty = await probeVault(r.vault, { probeWrite: true });
  assert.equal(empty.state, 'absent');
  assert.match(empty.message, /is the drive mounted/);
  assert.deepEqual(await listing(drive), [], 'no probe file, no marker, nothing written to the internal disk');
  assert.ok(!vaultReadable(empty.state) && !vaultWritable(empty.state));

  // Plugged back in.
  await fs.rmdir(drive);
  await fs.rename(elsewhere, drive);
  assert.equal((await probeVault(r.vault, { probeWrite: true, lowSpaceBytes: 0 })).state, 'ready');
});

test('probeVault: another vault mounted at the same path is foreign, not this one', async () => {
  const a = await initVault(await tmp(), 'A');
  const bDir = await tmp();
  const b = await initVault(bDir, 'B');
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const h = await probeVault({ ...a.vault, path: bDir }, { probeWrite: true });
  assert.equal(h.state, 'foreign');
  assert.match(h.message, /"B"/);
  assert.ok(!vaultReadable(h.state));
});

test('probeVault: a corrupt or alien marker is an error, never adopted', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, VAULT_MARKER_FILE), '{"formatVersion":1,"app":"other","id":"x"}');
  const h = await probeVault({ id: 'a'.repeat(32), label: 'X', path: dir });
  assert.equal(h.state, 'error');
  assert.equal((await initVault(dir, 'X')).ok, false);
});

test('probeVault: low space keeps the vault readable but not writable', async () => {
  const r = await initVault(await tmp(), 'SSD');
  assert.ok(r.ok);
  if (!r.ok) return;
  const h = await probeVault(r.vault, { lowSpaceBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(h.state, 'low-space');
  assert.ok(vaultReadable(h.state) && !vaultWritable(h.state));
  assert.ok((h.freeBytes ?? 0) > 0 && (h.totalBytes ?? 0) >= (h.freeBytes ?? 0));
});

/** The real filesystem, with chosen failures. */
function faultyFs(fault: { create?: string; stat?: string; statfs?: boolean }): VaultFs & { creates: number } {
  const f = {
    creates: 0,
    ...nodeVaultFs,
    async stat(p: string) {
      if (fault.stat) throw Object.assign(new Error(fault.stat), { code: fault.stat });
      return nodeVaultFs.stat(p);
    },
    async statfs(p: string) {
      if (fault.statfs) throw new Error('not supported');
      return nodeVaultFs.statfs(p);
    },
    async createExclusive(p: string) {
      f.creates++;
      if (fault.create) throw Object.assign(new Error(fault.create), { code: fault.create });
      return nodeVaultFs.createExclusive(p);
    },
  };
  return f;
}

test('probeVault: EROFS/EACCES read-only, ENOSPC full, EIO an error; statfs failure is not "low"', async () => {
  const r = await initVault(await tmp(), 'SSD');
  assert.ok(r.ok);
  if (!r.ok) return;
  for (const c of ['EROFS', 'EACCES', 'EPERM'])
    assert.equal((await probeVault(r.vault, { probeWrite: true, fs: faultyFs({ create: c }) })).state, 'read-only', c);
  assert.equal(
    (await probeVault(r.vault, { probeWrite: true, fs: faultyFs({ create: 'ENOSPC' }) })).state,
    'low-space',
  );
  assert.equal((await probeVault(r.vault, { probeWrite: true, fs: faultyFs({ create: 'EIO' }) })).state, 'error');
  assert.equal((await probeVault(r.vault, { fs: faultyFs({ stat: 'EIO' }) })).state, 'error');
  const noStatfs = await probeVault(r.vault, {
    fs: faultyFs({ statfs: true }),
    lowSpaceBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(noStatfs.state, 'ready');
  assert.equal(noStatfs.freeBytes, undefined);
});

test('VaultMonitor: reports pull and re-plug as changes, stays quiet otherwise, write-probes rarely', async () => {
  const drive = await tmp();
  const r = await initVault(drive, 'SSD');
  assert.ok(r.ok);
  if (!r.ok) return;
  let t = 0;
  const vfs = faultyFs({});
  const events: string[][] = [];
  const m = new VaultMonitor({
    vaults: () => [r.vault],
    fs: vfs,
    now: () => t,
    writeProbeEveryMs: 600_000,
    lowSpaceBytes: 0,
  });
  m.on('changed', ({ vaults }) => events.push(vaults.map((v) => v.state)));

  await m.check();
  assert.deepEqual(events, [['ready']]);
  assert.equal(vfs.creates, 1, 'first check write-probes');
  t += 30_000;
  await m.check();
  assert.equal(events.length, 1, 'no change, no event');
  assert.equal(vfs.creates, 1, 'no write probe between the ten-minute ones');

  await fs.rename(drive, `${drive}-x`);
  t += 30_000;
  await m.check();
  assert.deepEqual(events.at(-1), ['absent']);
  await fs.rename(`${drive}-x`, drive);
  t += 30_000;
  await m.check();
  assert.deepEqual(events.at(-1), ['ready']);
  assert.equal(vfs.creates, 2, 'coming back is confirmed with a write probe');
  assert.equal(m.get(r.vault.id)?.state, 'ready');
  t += 600_000;
  await m.check();
  assert.equal(vfs.creates, 3, 'and the periodic probe still runs');
});

test('VaultMonitor: a vault removed from settings disappears and is reported once', async () => {
  const r = await initVault(await tmp(), 'SSD');
  assert.ok(r.ok);
  if (!r.ok) return;
  let list = [r.vault];
  const m = new VaultMonitor({ vaults: () => list, lowSpaceBytes: 0 });
  let n = 0;
  m.on('changed', () => n++);
  await m.check();
  list = [];
  await m.check();
  assert.equal(n, 2);
  assert.deepEqual(m.current(), []);
});

test('initVault: a folder on the same drive as the app data is refused — an empty mount point looks like that', async () => {
  const appData = await tmp();
  const mountPoint = await tmp(); // same filesystem as appData: what /mnt/ssd is with nothing mounted
  const r = await initVault(mountPoint, 'SSD', { appDataDir: appData });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /same drive as WorldView's own data.*is the drive mounted/);
  assert.deepEqual(await listing(mountPoint), [], 'nothing written');
  assert.equal((await initVault(mountPoint, 'SSD', { appDataDir: appData, allowSameDrive: true })).ok, true);
});

test('initVault and vaultPacksDir: a worldpacks link off the drive is refused', async () => {
  const drive = await tmp();
  const elsewhere = await tmp();
  await fs.symlink(elsewhere, path.join(drive, VAULT_PACKS_DIR));
  const r = await initVault(drive, 'SSD');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : '', /is a link/);
  assert.deepEqual(await listing(drive), [VAULT_PACKS_DIR], 'no marker written');
  const d = await vaultPacksDir(drive);
  assert.equal(d.ok, false);
});

test('VaultMonitor: a check asked for during a running pass sees a vault added in between', async () => {
  const a = await initVault(await tmp(), 'A');
  const b = await initVault(await tmp(), 'B');
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  let list = [a.vault];
  const m = new VaultMonitor({ vaults: () => list, lowSpaceBytes: 0 });
  const first = m.check();
  list = [a.vault, b.vault];
  await first;
  await m.check();
  assert.equal(m.get(b.vault.id)?.state, 'ready');
});
