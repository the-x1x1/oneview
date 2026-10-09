import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@worldview/provider-sdk';
import { VaultPackError, WorldPackRegistry, type RegistryVault, type VaultInstallTarget } from './registry.js';
import { VAULT_MARKER_FILE, VAULT_PACKS_DIR, initVault, type VaultState } from './vault.js';
import { writeTestPack } from '../test/helpers/pack.js';
import { tempDir } from '../test/helpers/raw-zip.js';

const { VirtualClock } = testing;

/** An app data folder, a vault on a "drive", and a registry that sees the vault in `state`. */
async function setup() {
  const dir = await tempDir();
  const dataDir = path.join(dir, 'app');
  const drive = path.join(dir, 'ssd');
  await fs.mkdir(drive);
  const init = await initVault(drive, 'Field SSD');
  assert.ok(init.ok);
  if (!init.ok) throw new Error('vault');
  const vault = { id: init.vault.id, label: init.vault.label, root: drive, state: 'ready' as VaultState };
  let configured: RegistryVault[] = [vault];
  const reg = new WorldPackRegistry({
    dataDir,
    appVersion: '0.1.0',
    clock: new VirtualClock(Date.parse('2026-10-08T12:00:00Z')),
    vaults: () => configured,
  });
  const file = path.join(dir, 'oahu.worldpack');
  await writeTestPack(file, { id: 'oahu-test', name: 'Oahu' });
  return {
    dir,
    dataDir,
    drive,
    vault,
    reg,
    file,
    setVaults: (v: RegistryVault[]) => {
      configured = v;
    },
    target: (recheck: () => Promise<string | undefined> = async () => undefined): VaultInstallTarget => ({
      vault,
      recheck,
    }),
  };
}

test('vault: a pack installs onto the vault, its state stays in the app folder, and it is searched like any other', async () => {
  const s = await setup();
  await s.reg.refresh();
  const r = await s.reg.install(s.file, s.target());
  assert.ok(r.installed, r.issues.join('; '));
  assert.deepEqual(r.installed?.vault, { id: s.vault.id, label: 'Field SSD' });
  assert.equal(r.installed?.status, 'active');
  assert.ok((await fs.stat(path.join(s.drive, VAULT_PACKS_DIR, 'oahu-test', 'manifest.json'))).isFile());
  assert.deepEqual(await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR, '.staging')), [], 'vault staging cleaned');
  assert.ok(!(await fs.readdir(path.join(s.dataDir, 'worldpacks'))).includes('oahu-test'), 'nothing in the app folder');
  const state = JSON.parse(await fs.readFile(path.join(s.dataDir, 'worldpacks', 'state.json'), 'utf8'));
  assert.equal(state.packs['oahu-test'].vault.id, s.vault.id);
  assert.equal(s.reg.placeIndex().search('Honolulu')[0]?.entry.name, 'Honolulu');
  assert.equal(s.reg.capabilities().localSearch, true);
});

test('vault: pulling the drive lists its packs as not connected; plugging it back restores them as they were', async () => {
  const s = await setup();
  await s.reg.refresh();
  await s.reg.install(s.file, s.target());
  await s.reg.setEnabled('oahu-test', false);
  const before = await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR, 'oahu-test'));

  s.vault.state = 'absent';
  await s.reg.refresh();
  const away = s.reg.get('oahu-test');
  assert.equal(away?.summary.status, 'invalid');
  assert.match(away?.summary.message ?? '', /"Field SSD", which is not connected/);
  assert.equal(away?.summary.name, 'Oahu', 'remembered while away');
  assert.equal(s.reg.capabilities().localSearch, false);
  assert.deepEqual(s.reg.pmtilesPaths(), []);
  assert.deepEqual(s.reg.active(), []);

  s.vault.state = 'ready';
  await s.reg.refresh();
  assert.equal(s.reg.get('oahu-test')?.summary.status, 'disabled', 'switched off before the pull, still off');
  assert.deepEqual(await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR, 'oahu-test')), before, 'files untouched');
  await s.reg.setEnabled('oahu-test', true);
  assert.equal(s.reg.get('oahu-test')?.summary.status, 'active');
});

test('vault: read-only and low-space vaults are read; nothing is installed into them', async () => {
  const s = await setup();
  await s.reg.refresh();
  await s.reg.install(s.file, s.target());
  for (const state of ['read-only', 'low-space'] as const) {
    s.vault.state = state;
    await s.reg.refresh();
    assert.equal(s.reg.get('oahu-test')?.summary.status, 'active', state);
    const other = path.join(s.dir, `${state}.worldpack`);
    await writeTestPack(other, { id: `other-${state}` });
    const r = await s.reg.install(other, s.target());
    assert.equal(r.installed, null);
    assert.match(r.issues[0] ?? '', new RegExp(`cannot be written to \\(${state}\\)`));
  }
  assert.deepEqual((await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR))).sort(), ['.staging', 'oahu-test']);
});

test('vault: a drive pulled during an install is not written to again, and the pack is not activated', async () => {
  const s = await setup();
  await s.reg.refresh();
  let calls = 0;
  const r = await s.reg.install(
    s.file,
    s.target(async () => (++calls === 1 ? undefined : '"Field SSD" is not connected')),
  );
  assert.equal(calls, 2, 'checked before writing and again before activating');
  assert.equal(r.installed, null);
  assert.match(r.issues[0] ?? '', /not activated: "Field SSD" is not connected/);
  assert.ok(!(await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR))).includes('oahu-test'));
  assert.equal(s.reg.get('oahu-test'), undefined);

  // Refused before anything is written when the first check fails.
  const dirsBefore = await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR));
  const r2 = await s.reg.install(
    s.file,
    s.target(async () => 'gone'),
  );
  assert.deepEqual(r2.issues, ['gone']);
  assert.deepEqual(await fs.readdir(path.join(s.drive, VAULT_PACKS_DIR)), dirsBefore);
});

test('vault: the registry never deletes a pack on a vault', async () => {
  const s = await setup();
  await s.reg.refresh();
  await s.reg.install(s.file, s.target());
  await assert.rejects(s.reg.remove('oahu-test'), (e: unknown) => {
    assert.ok(e instanceof VaultPackError);
    assert.match(e.message, /does not delete files on a vault/);
    return true;
  });
  assert.ok((await fs.stat(path.join(s.drive, VAULT_PACKS_DIR, 'oahu-test', 'manifest.json'))).isFile());
});

test('vault: the same pack in the app folder and on a vault is used once, the other listed under its own id', async () => {
  const s = await setup();
  await s.reg.refresh();
  await s.reg.install(s.file); // into the app folder
  await fs.cp(path.join(s.dataDir, 'worldpacks', 'oahu-test'), path.join(s.drive, VAULT_PACKS_DIR, 'oahu-test'), {
    recursive: true,
  });
  await s.reg.refresh();
  assert.equal(s.reg.get('oahu-test')?.vault, undefined, 'the app folder copy is used');
  const dup = s.reg.get(`oahu-test:${s.vault.id}`);
  assert.equal(dup?.summary.status, 'invalid');
  assert.match(dup?.summary.message ?? '', /the copy on this computer is used/);
  // And installing it onto the vault while it is in the app folder is refused, not moved.
  const r = await s.reg.install(s.file, s.target());
  assert.match(r.issues[0] ?? '', /already installed on this computer/);
});

test('vault: a vault taken out of settings is forgotten here, its files left alone', async () => {
  const s = await setup();
  await s.reg.refresh();
  await s.reg.install(s.file, s.target());
  s.setVaults([]);
  await s.reg.refresh();
  assert.equal(s.reg.get('oahu-test'), undefined);
  const state = JSON.parse(await fs.readFile(path.join(s.dataDir, 'worldpacks', 'state.json'), 'utf8'));
  assert.equal(state.packs['oahu-test'], undefined);
  assert.ok((await fs.stat(path.join(s.drive, VAULT_PACKS_DIR, 'oahu-test', 'manifest.json'))).isFile());
});

test('vault: reading a vault without a worldpacks folder creates nothing on it', async () => {
  const s = await setup();
  await fs.rm(path.join(s.drive, VAULT_PACKS_DIR), { recursive: true });
  await s.reg.refresh();
  assert.deepEqual(await fs.readdir(s.drive), [VAULT_MARKER_FILE]);
  assert.deepEqual(s.reg.summaries(), []);
});
