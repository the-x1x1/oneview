import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertReleaseVersion,
  expectedArtifacts,
  expectedLinuxArtifacts,
  formatAssertVersion,
  releaseAssetPaths,
} from './assert-version.js';

const V = '0.3.0-rc.1';
const COMMIT = 'c'.repeat(40);

/** A Linux release folder as `pnpm release:package` + `sbom` + `release:verify` leave it on Linux. */
function linuxRelease(opts: { extra?: string[]; omit?: string[]; feed?: string; hashed?: string[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wv-release-linux-'));
  const l = expectedLinuxArtifacts(V);
  mkdirSync(path.join(root, 'apps', 'desktop', 'release'), { recursive: true });
  mkdirSync(path.join(root, 'artifacts', 'release'), { recursive: true });
  writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version: V }));
  const rel = (f: string) => path.join(root, 'apps', 'desktop', 'release', f);
  const out = (f: string) => path.join(root, 'artifacts', 'release', f);
  for (const f of [l.deb, l.appImage, ...(opts.extra ?? [])])
    if (!(opts.omit ?? []).includes(f)) writeFileSync(rel(f), 'x');
  writeFileSync(rel('latest-linux.yml'), opts.feed ?? `version: ${V}\npath: ${l.appImage}\nsha512: x\n`);
  writeFileSync(
    out(l.sbom),
    JSON.stringify({
      metadata: { component: { version: V }, properties: [{ name: 'worldview:commit', value: COMMIT }] },
    }),
  );
  const hashes = (opts.hashed ?? [l.deb, l.appImage, 'latest-linux.yml']).map((file) => ({
    file,
    sha256: 'e'.repeat(64),
    sizeBytes: 1,
  }));
  writeFileSync(
    out('verification-report.json'),
    JSON.stringify({ release: V, commitSha: COMMIT, artifactHashes: hashes }),
  );
  writeFileSync(out('SHA256SUMS.txt'), hashes.map((h) => `${h.sha256}  ${h.file}`).join('\n') + '\n');
  return root;
}

function withRoot(root: string, fn: () => void): void {
  try {
    fn();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('linux artifact names are the ones electron-builder.yml declares', () => {
  const l = expectedLinuxArtifacts(V);
  assert.equal(l.deb, `worldview_${V}_amd64.deb`);
  assert.equal(l.appImage, `WorldView-${V}-x86_64.AppImage`);
  assert.equal(l.sbom, expectedArtifacts(V).sbom, 'one SBOM name: it describes the lockfile, not the platform');
});

test('release:assert-version --platform linux passes on a complete Linux release', () => {
  const root = linuxRelease();
  withRoot(root, () => {
    const r = assertReleaseVersion({ root, tag: `v${V}`, commit: COMMIT, requireTag: true, platform: 'linux' });
    assert.deepEqual(r.problems, []);
    assert.equal(r.platform, 'linux');
    const text = formatAssertVersion(r);
    assert.match(text, /\(linux\)/);
    for (const f of releaseAssetPaths(V, 'linux')) assert.ok(text.includes(f), f);
    assert.ok(!text.includes('.exe'), 'a Linux release lists no Windows asset');
  });
});

test('release:assert-version --platform linux fails on a missing package, a stale one, or a Windows file', () => {
  const l = expectedLinuxArtifacts(V);
  const root = linuxRelease({
    omit: [l.appImage],
    extra: ['worldview_0.2.9_amd64.deb', `WorldView-Setup-${V}.exe`],
  });
  withRoot(root, () => {
    const r = assertReleaseVersion({ root, commit: COMMIT, platform: 'linux' });
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.problems.sort(),
      [
        `missing apps/desktop/release/${l.appImage}`,
        `stale or foreign artifact apps/desktop/release/WorldView-Setup-${V}.exe`,
        'stale or foreign artifact apps/desktop/release/worldview_0.2.9_amd64.deb',
      ].sort(),
    );
  });
});

test('release:assert-version --platform linux checks latest-linux.yml and that the report hashed the .deb', () => {
  const root = linuxRelease({
    feed: 'version: 0.2.9\npath: WorldView-0.2.9-x86_64.AppImage\n',
    hashed: ['latest-linux.yml'],
  });
  withRoot(root, () => {
    const text = assertReleaseVersion({ root, commit: COMMIT, platform: 'linux' }).problems.join('\n');
    assert.match(text, /latest-linux\.yml version 0\.2\.9 is not/);
    assert.match(text, /latest-linux\.yml path WorldView-0\.2\.9-x86_64\.AppImage/);
    assert.match(text, /verification report does not hash worldview_0\.3\.0-rc\.1_amd64\.deb/);
  });
});

test('the default platform is still Windows, so the existing gate is unchanged', () => {
  const root = linuxRelease();
  withRoot(root, () => {
    const r = assertReleaseVersion({ root, commit: COMMIT });
    assert.equal(r.platform, 'win32');
    assert.ok(r.problems.includes(`missing apps/desktop/release/${expectedArtifacts(V).installer}`));
    assert.ok(r.problems.some((p) => p.includes('stale or foreign artifact') && p.endsWith('.deb')));
  });
});
