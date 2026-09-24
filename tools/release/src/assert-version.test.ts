import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertReleaseVersion, expectedArtifacts } from './assert-version.js';

const V = '0.1.0-rc.5';
const COMMIT = 'a'.repeat(40);

function release(
  opts: {
    version?: string;
    extra?: string[];
    sbomVersion?: string;
    reportRelease?: string;
    reportCommit?: string;
    latest?: string;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'wv-release-'));
  const v = opts.version ?? V;
  const want = expectedArtifacts(v);
  mkdirSync(path.join(root, 'apps', 'desktop', 'release'), { recursive: true });
  mkdirSync(path.join(root, 'artifacts', 'release'), { recursive: true });
  writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version: v }));
  const rel = (f: string) => path.join(root, 'apps', 'desktop', 'release', f);
  const out = (f: string) => path.join(root, 'artifacts', 'release', f);
  for (const f of [want.installer, want.blockmap, want.portable, ...(opts.extra ?? [])])
    writeFileSync(f.endsWith('.sbom.json') ? out(f) : rel(f), 'x');
  writeFileSync(rel('latest.yml'), opts.latest ?? `version: ${v}\npath: ${want.installer}\nsha512: x\n`);
  writeFileSync(
    out(want.sbom),
    JSON.stringify({
      metadata: {
        component: { version: opts.sbomVersion ?? v },
        properties: [{ name: 'worldview:commit', value: COMMIT }],
      },
    }),
  );
  const hashes = [want.installer, want.portable, want.blockmap, 'latest.yml'].map((file) => ({
    file,
    sha256: 'f'.repeat(64),
    sizeBytes: 1,
  }));
  writeFileSync(
    out('verification-report.json'),
    JSON.stringify({
      release: opts.reportRelease ?? v,
      commitSha: opts.reportCommit ?? COMMIT,
      artifactHashes: hashes,
    }),
  );
  writeFileSync(out('SHA256SUMS.txt'), hashes.map((h) => `${h.sha256}  ${h.file}`).join('\n') + '\n');
  return root;
}

test('release:assert-version passes when every artifact is this version and this commit', () => {
  const root = release();
  try {
    const r = assertReleaseVersion({ root, tag: `v${V}`, commit: COMMIT, requireTag: true });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release:assert-version fails on the rc.4 mistake: the previous version’s installer, zip and SBOM beside this one', () => {
  const root = release({
    extra: ['WorldView-Setup-0.1.0-rc.4.exe', 'WorldView-Portable-0.1.0-rc.4.zip', 'WorldView-0.1.0-rc.4.sbom.json'],
  });
  try {
    const r = assertReleaseVersion({ root, commit: COMMIT });
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.problems.sort(),
      [
        'stale or foreign SBOM artifacts/release/WorldView-0.1.0-rc.4.sbom.json',
        'stale or foreign artifact apps/desktop/release/WorldView-Portable-0.1.0-rc.4.zip',
        'stale or foreign artifact apps/desktop/release/WorldView-Setup-0.1.0-rc.4.exe',
      ].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release:assert-version fails on a wrong tag, a stale report, SBOM or latest.yml, and a missing tag when one is required', () => {
  const root = release({
    sbomVersion: '0.1.0-rc.4',
    reportRelease: '0.1.0-rc.4',
    reportCommit: 'b'.repeat(40),
    latest: 'version: 0.1.0-rc.4\npath: WorldView-Setup-0.1.0-rc.4.exe\n',
  });
  try {
    const r = assertReleaseVersion({ root, tag: 'v0.1.0-rc.4', commit: COMMIT });
    const text = r.problems.join('\n');
    assert.match(text, /tag v0\.1\.0-rc\.4 is not v0\.1\.0-rc\.5/);
    assert.match(text, /SBOM names version 0\.1\.0-rc\.4/);
    assert.match(text, /verification report is for 0\.1\.0-rc\.4/);
    assert.match(text, /verification report is for commit b{40}/);
    assert.match(text, /latest\.yml version 0\.1\.0-rc\.4/);
    assert.match(text, /latest\.yml path WorldView-Setup-0\.1\.0-rc\.4\.exe/);
    assert.equal(
      assertReleaseVersion({ root, commit: COMMIT, requireTag: true }).problems.some((p) => /no release tag/.test(p)),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release:assert-version fails when nothing was packaged, or the report was written before packaging', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wv-release-'));
  try {
    mkdirSync(path.join(root, 'apps', 'desktop'), { recursive: true });
    writeFileSync(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version: V }));
    const r = assertReleaseVersion({ root });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes(`missing apps/desktop/release/WorldView-Setup-${V}.exe`));
    assert.ok(r.problems.includes(`missing artifacts/release/WorldView-${V}.sbom.json`));
    assert.ok(r.problems.includes('missing artifacts/release/verification-report.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
