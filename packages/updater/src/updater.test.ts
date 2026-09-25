import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UpdaterState } from '@worldview/ipc-contract';
import {
  UpdaterController,
  compareVersions,
  isAcceptableUpdate,
  isPrereleaseVersion,
  policyInputFromSettings,
  resolveUpdatePolicy,
  __resolveAutoUpdaterForTest,
  type AutoUpdaterLike,
  type ProgressInfoLike,
  type UpdateInfoLike,
  type UpdatePolicyInput,
} from './index.js';

type Listener = (...args: never[]) => void;

/** Fake electron-updater: records flag writes, lets tests fire events and script check/download. */
class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  calls: string[] = [];
  offered: UpdateInfoLike | null = null;
  failCheck: Error | undefined;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  async checkForUpdates() {
    this.calls.push('check');
    if (this.failCheck) throw this.failCheck;
    this.emit('checking-for-update');
    if (this.offered) {
      this.emit('update-available', this.offered);
      if (this.autoDownload) {
        this.emit('download-progress', { percent: 50, transferred: 1, total: 2 } satisfies ProgressInfoLike);
        this.emit('update-downloaded', this.offered);
      }
      return { updateInfo: this.offered };
    }
    this.emit('update-not-available', { version: '0.1.0' });
    return null;
  }
  async downloadUpdate() {
    this.calls.push('download');
    return ['/tmp/WorldView-Setup.exe'];
  }
  quitAndInstall() {
    this.calls.push('quitAndInstall');
  }
  removeAllListeners() {
    this.listeners.clear();
    return this;
  }
}

test('update policy matrix: signed/unsigned × channel × automatic', () => {
  const cases: Array<[UpdatePolicyInput, Partial<ReturnType<typeof resolveUpdatePolicy>>]> = [
    [
      { signed: false, channel: 'stable', automatic: true, packaged: true },
      { enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false },
    ],
    [
      { signed: false, channel: 'stable', automatic: false, packaged: true },
      { enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false },
    ],
    [
      { signed: false, channel: 'prerelease', automatic: true, packaged: true },
      { enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true },
    ],
    [
      { signed: false, channel: 'prerelease', automatic: false, packaged: true },
      { enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true },
    ],
    [
      { signed: true, channel: 'stable', automatic: true, packaged: true },
      { enabled: true, autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false },
    ],
    [
      { signed: true, channel: 'stable', automatic: false, packaged: true },
      { enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false },
    ],
    [
      { signed: true, channel: 'prerelease', automatic: true, packaged: true },
      { enabled: true, autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true },
    ],
    [
      { signed: true, channel: 'prerelease', automatic: false, packaged: true },
      { enabled: true, autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: true },
    ],
    [
      { signed: true, channel: 'stable', automatic: true, packaged: false },
      { enabled: false, autoDownload: false, autoInstallOnAppQuit: false },
    ],
  ];
  for (const [input, expected] of cases) {
    const d = resolveUpdatePolicy(input);
    for (const [k, v] of Object.entries(expected))
      assert.equal(d[k as keyof typeof d], v, `${JSON.stringify(input)} → ${k}`);
    assert.equal(d.installRequiresUserAction, true);
    assert.ok(d.reason.length > 10);
  }
  assert.deepEqual(policyInputFromSettings({ automatic: true, prerelease: true }, { signed: false, packaged: true }), {
    channel: 'prerelease',
    automatic: true,
    signed: false,
    packaged: true,
  });
  assert.equal(
    policyInputFromSettings({ automatic: false, prerelease: false }, { signed: true, packaged: true }).channel,
    'stable',
  );
});

test('version rules: prerelease never replaces stable unless opted in; never downgrade', () => {
  assert.equal(isPrereleaseVersion('0.2.0-rc.1'), true);
  assert.equal(isPrereleaseVersion('0.2.0'), false);
  assert.ok(compareVersions('0.2.0', '0.2.0-rc.1') > 0);
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('garbage', '1.0.0'), 0);
  assert.equal(isAcceptableUpdate('0.1.0', '0.2.0-rc.1', { allowPrerelease: false }).ok, false);
  assert.equal(isAcceptableUpdate('0.1.0', '0.2.0-rc.1', { allowPrerelease: true }).ok, true);
  assert.equal(isAcceptableUpdate('0.1.0', '0.2.0', { allowPrerelease: false }).ok, true);
  assert.equal(isAcceptableUpdate('0.2.0', '0.1.0', { allowPrerelease: true }).ok, false, 'downgrade refused');
  assert.equal(isAcceptableUpdate('0.1.0', 'not-a-version', { allowPrerelease: true }).ok, false);
});

test('controller: unsigned build checks and notifies only; install is explicit and downloads then installs', async () => {
  const fake = new FakeAutoUpdater();
  fake.offered = { version: '0.2.0' };
  const states: UpdaterState['status'][] = [];
  const ctl = new UpdaterController({
    updater: fake,
    currentVersion: '0.1.0',
    policy: () => ({ signed: false, channel: 'stable', automatic: true, packaged: true }),
  });
  ctl.onChange((s) => states.push(s.status));
  assert.equal(fake.autoDownload, false, 'policy applied to the updater: no background download for unsigned');
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.equal(fake.allowPrerelease, false);
  assert.equal(fake.allowDowngrade, false);
  assert.equal(
    ctl.state().automatic,
    false,
    'UpdaterState.automatic reflects the effective policy, not the raw setting',
  );

  const after = await ctl.check();
  assert.equal(after.status, 'available');
  assert.equal(after.availableVersion, '0.2.0');
  assert.equal(after.signed, false);
  assert.match(after.message ?? '', /unsigned/);
  assert.deepEqual(fake.calls, ['check'], 'no download happened on its own');

  const installed = await ctl.install();
  assert.deepEqual(fake.calls, ['check', 'download', 'quitAndInstall']);
  assert.equal(installed.status, 'downloaded');
  assert.deepEqual(states, ['checking', 'checking', 'available', 'downloading', 'downloaded']);
});

test('controller: signed automatic build downloads in the background; install with nothing available is a no-op', async () => {
  const fake = new FakeAutoUpdater();
  fake.offered = { version: '0.2.0' };
  const ctl = new UpdaterController({
    updater: fake,
    currentVersion: '0.1.0',
    policy: () => ({ signed: true, channel: 'stable', automatic: true, packaged: true }),
  });
  assert.equal(fake.autoDownload, true);
  const s = await ctl.check();
  assert.equal(s.status, 'downloaded');
  assert.equal(ctl.downloadProgress(), undefined, 'progress cleared once downloaded');
  await ctl.install();
  assert.ok(fake.calls.includes('quitAndInstall'));

  const idle = new UpdaterController({
    updater: new FakeAutoUpdater(),
    currentVersion: '0.1.0',
    policy: () => ({ signed: true, channel: 'stable', automatic: false, packaged: true }),
  });
  const r = await idle.install();
  assert.equal(r.status, 'idle');
  assert.match(r.message ?? '', /no update is available/);
});

test('controller: a prerelease offered to a stable-channel install is rejected even if the feed misbehaves', async () => {
  const fake = new FakeAutoUpdater();
  fake.offered = { version: '0.2.0-rc.1' };
  const settings = { automatic: false, prerelease: false };
  const ctl = new UpdaterController({
    updater: fake,
    currentVersion: '0.1.0',
    policy: () => policyInputFromSettings(settings, { signed: true, packaged: true }),
  });
  const s = await ctl.check();
  assert.equal(s.status, 'up-to-date');
  assert.match(s.message ?? '', /prerelease channel is not enabled/);

  settings.prerelease = true;
  ctl.applyPolicy();
  assert.equal(fake.allowPrerelease, true);
  assert.equal(ctl.state().channel, 'prerelease');
  const s2 = await ctl.check();
  assert.equal(s2.status, 'available');
  assert.equal(s2.availableVersion, '0.2.0-rc.1');
});

test('controller: disabled when unpackaged; errors are sanitized and never contain secrets', async () => {
  const dev = new UpdaterController({
    updater: new FakeAutoUpdater(),
    currentVersion: '0.1.0',
    policy: () => ({ signed: false, channel: 'stable', automatic: false, packaged: false }),
  });
  assert.equal(dev.state().status, 'disabled');
  assert.equal((await dev.check()).status, 'disabled');
  assert.equal((await dev.install()).status, 'disabled');

  const fake = new FakeAutoUpdater();
  fake.failCheck = new Error(
    'GET https://api.github.com/repos/x/y/releases?token=SECRET123 failed: ' + 'x'.repeat(500),
  );
  const ctl = new UpdaterController({
    updater: fake,
    currentVersion: '0.1.0',
    policy: () => ({ signed: true, channel: 'stable', automatic: false, packaged: true }),
  });
  const s = await ctl.check();
  assert.equal(s.status, 'error');
  assert.ok(!(s.message ?? '').includes('SECRET123'));
  assert.ok((s.message ?? '').length <= 230);
  assert.equal(s.lastCheckedAt !== undefined, true);
});

test('controller: a repository with only pre-releases is "no stable release yet", not an error', async () => {
  const fake = new FakeAutoUpdater();
  fake.failCheck = new Error(
    'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/the-x1x1/oneview/releases/latest), please ensure a production release exists: HttpError: 406 "method: GET',
  );
  const controller = (channel: 'stable' | 'prerelease') =>
    new UpdaterController({
      updater: fake,
      currentVersion: '0.1.7',
      policy: () => ({ signed: false, channel, automatic: false, packaged: true }),
    });
  const s = await controller('stable').check();
  assert.equal(s.status, 'up-to-date');
  assert.match(s.message ?? '', /no stable release is published yet; turn on "Include pre-release builds"/);
  const p = await controller('prerelease').check();
  assert.equal(p.status, 'up-to-date');
  assert.match(p.message ?? '', /no release is published that this build can update from/);
});

test('electron-updater interop: autoUpdater is taken from wherever the namespace put it', () => {
  const updater = { autoDownload: false } as unknown as AutoUpdaterLike;

  // What Node produces for electron-updater today: the named export is invisible to
  // cjs-module-lexer because the getter is an arrow function with an expression body, so
  // the binding survives only on `default`. Reading `mod.autoUpdater` gave undefined and
  // the packaged app died on `updater.logger = …` before opening a window.
  assert.equal(__resolveAutoUpdaterForTest({ default: { autoUpdater: updater } }), updater);

  // And the shape it would have if the lexer ever did recognise it.
  assert.equal(__resolveAutoUpdaterForTest({ autoUpdater: updater }), updater);

  // Neither position: fail by name, not with "Cannot set properties of undefined".
  assert.throws(() => __resolveAutoUpdaterForTest({}), /electron-updater loaded but exposed no `autoUpdater`/);
});
