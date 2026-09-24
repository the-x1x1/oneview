import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLockfile, parsePackageKey } from './lockfile.js';
import { buildSbom, deterministicUuid } from './sbom.js';
import { buildVerificationReport, sha256SumsText } from './verify.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLE = path.join(repoRoot, 'fixtures', 'release', 'sample-pnpm-lock.yaml');

test('lockfile: package keys parse, including scopes and peer suffixes', () => {
  assert.deepEqual(parsePackageKey('cesium@1.124.0'), { name: 'cesium', version: '1.124.0' });
  assert.deepEqual(parsePackageKey("'@duckdb/node-api@1.1.3'"), { name: '@duckdb/node-api', version: '1.1.3' });
  assert.deepEqual(parsePackageKey('/react-dom@19.0.0(react@19.0.0)'), { name: 'react-dom', version: '19.0.0' });
  assert.equal(parsePackageKey('not-a-package'), undefined);
});

test('lockfile: importers, versions, integrity and dev flags are read', () => {
  const lock = parseLockfile(readFileSync(SAMPLE, 'utf8'));
  assert.equal(lock.lockfileVersion, '9.0');
  assert.deepEqual(lock.importers, ['.', 'apps/desktop']);
  const names = lock.packages.map((p) => `${p.name}@${p.version}`);
  assert.deepEqual(names, [
    '@duckdb/node-api@1.1.3',
    'cesium@1.124.0',
    'electron@33.2.1',
    'electron-updater@6.3.9',
    'typescript@5.9.2',
  ]);
  const cesium = lock.packages.find((p) => p.name === 'cesium')!;
  assert.ok(cesium.integrity?.startsWith('sha512-'));
  assert.equal(lock.packages.find((p) => p.name === 'electron')!.dev, true);
  assert.equal(cesium.dev, false);
});

function scaffoldRepo(withLock: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-release-'));
  mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
  mkdirSync(path.join(dir, 'apps', 'desktop'), { recursive: true });
  mkdirSync(path.join(dir, 'config', 'licenses'), { recursive: true });
  writeFileSync(
    path.join(dir, 'packages', 'core', 'package.json'),
    JSON.stringify({ name: '@worldview/core', version: '0.1.0' }),
  );
  writeFileSync(
    path.join(dir, 'apps', 'desktop', 'package.json'),
    JSON.stringify({ name: '@worldview/desktop', version: '0.1.0-rc.1' }),
  );
  writeFileSync(
    path.join(dir, 'config', 'licenses', 'software.json'),
    JSON.stringify({
      records: [
        {
          name: 'go2rtc',
          license: 'MIT',
          commitOrVersion: '1.9.14',
          integration: 'sidecar',
          distribution: 'optional',
          repository: 'https://github.com/AlexxIT/go2rtc',
        },
        {
          name: 'readsb',
          license: 'GPL-3.0',
          commitOrVersion: 'external',
          integration: 'external-service',
          distribution: 'not-distributed',
        },
        { name: 'cesium', license: 'Apache-2.0', integration: 'dependency', distribution: 'bundled' },
      ],
    }),
  );
  if (withLock) copyFileSync(SAMPLE, path.join(dir, 'pnpm-lock.yaml'));
  return dir;
}

test('sbom: CycloneDX shape, runtime-only by default, sidecars included, deterministic serial', () => {
  const dir = scaffoldRepo(true);
  try {
    const sbom = buildSbom({ root: dir, version: '0.1.0-rc.1', commit: 'abc123', now: () => 0 });
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.equal(sbom.specVersion, '1.5');
    assert.equal(sbom.metadata.component.name, 'WorldView');
    const names = sbom.components.map((c) => c.name);
    assert.ok(names.includes('cesium'));
    assert.ok(!names.includes('typescript'), 'devDependencies are excluded from a release SBOM');
    assert.ok(names.includes('@worldview/core'), 'workspace packages are listed');
    assert.ok(names.includes('go2rtc'), 'optional sidecars are listed');
    assert.equal(sbom.components.find((c) => c.name === 'readsb')?.scope, 'excluded');
    assert.equal(sbom.components.find((c) => c.name === 'cesium')?.purl, 'pkg:npm/cesium@1.124.0');
    assert.equal(sbom.components.find((c) => c.name === '@duckdb/node-api')?.purl, 'pkg:npm/%40duckdb/node-api@1.1.3');
    assert.ok(sbom.components.find((c) => c.name === 'cesium')?.hashes?.[0]?.alg === 'SHA-512');
    assert.equal(sbom.metadata.properties.find((p) => p.name === 'worldview:lockfile')?.value, 'pnpm-lock.yaml (v9.0)');
    const again = buildSbom({ root: dir, version: '0.1.0-rc.1', commit: 'abc123', now: () => 1000 });
    assert.equal(again.serialNumber, sbom.serialNumber, 'serial is deterministic for identical inputs');
    const withDev = buildSbom({ root: dir, version: '0.1.0-rc.1', includeDev: true, now: () => 0 });
    assert.ok(withDev.components.map((c) => c.name).includes('typescript'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sbom: a missing lockfile is stated, not faked', () => {
  const dir = scaffoldRepo(false);
  try {
    const sbom = buildSbom({ root: dir, version: '0.1.0-rc.1', now: () => 0 });
    assert.equal(sbom.metadata.properties.find((p) => p.name === 'worldview:lockfile')?.value, 'absent');
    assert.equal(sbom.metadata.properties.find((p) => p.name === 'worldview:lockfileSha256')?.value, 'n/a');
    assert.ok(sbom.components.every((c) => !c.purl || c.purl.startsWith('pkg:npm/')));
    assert.ok(sbom.components.some((c) => c.name === '@worldview/core'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deterministic uuid is stable and uuid-shaped', () => {
  const a = deterministicUuid('x');
  assert.equal(a, deterministicUuid('x'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, deterministicUuid('y'));
});

test('verification report: collects evidence, hashes artifacts, reports gaps honestly', () => {
  const dir = scaffoldRepo(true);
  try {
    const v = path.join(dir, 'artifacts', 'verification');
    mkdirSync(path.join(v, 'tests'), { recursive: true });
    mkdirSync(path.join(v, 'providers'), { recursive: true });
    mkdirSync(path.join(v, 'benchmarks'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'releases'), { recursive: true });
    mkdirSync(path.join(dir, 'release-out'), { recursive: true });
    writeFileSync(
      path.join(v, 'tests', 'all.json'),
      JSON.stringify({ fileCount: 99, pass: 454, fail: 0, skipped: 7, ranAt: '2026-09-21T10:00:00Z' }),
    );
    writeFileSync(
      path.join(v, 'tests', 'offline.json'),
      JSON.stringify({ fileCount: 1, pass: 1, fail: 0, skipped: 0, ranAt: '2026-09-21T10:01:00Z' }),
    );
    writeFileSync(
      path.join(v, 'providers', 'usgs-earthquakes.json'),
      JSON.stringify({
        providerId: 'usgs-earthquakes',
        passed: true,
        summary: { pass: 16, fail: 0, skip: 0 },
        ranAt: '2026-09-21T10:02:00Z',
      }),
    );
    writeFileSync(path.join(v, 'boundary-check.json'), JSON.stringify({ passed: true, filesChecked: 436 }));
    writeFileSync(path.join(v, 'license-audit.json'), JSON.stringify({ passed: true, findings: [] }));
    writeFileSync(path.join(v, 'typecheck.json'), JSON.stringify({ passed: true, shimsActive: ['cesium'] }));
    writeFileSync(path.join(v, 'benchmarks', 'presentation.json'), JSON.stringify({ medianMs: 26 }));
    writeFileSync(
      path.join(dir, 'docs', 'releases', 'KNOWN-LIMITATIONS.md'),
      '# Known limitations\n\n- Offline 3D terrain is ellipsoid only.\n- OpenSky is excluded by licence.\n',
    );
    writeFileSync(path.join(dir, 'release-out', 'WorldView-Setup-0.1.0-rc.1.exe'), 'fake installer bytes');

    const report = buildVerificationReport({
      root: dir,
      release: '0.1.0-rc.1',
      artifactsDir: path.join(dir, 'release-out'),
      now: () => 0,
    });
    assert.equal(report.tests['all']?.pass, 454);
    assert.equal(report.providerVerification.length, 1);
    assert.equal(report.artifactHashes.length, 1);
    assert.match(report.artifactHashes[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.knownLimitations.length, 2);
    assert.equal(report.knownFailures.length, 0);
    assert.equal(report.passed, true);
    assert.ok(report.notVerifiedHere.some((n) => n.includes('declaration shims')));
    assert.ok(report.notVerifiedHere.some((n) => n.includes('dependency audit')));
    assert.equal(report.sbom.present, false);
    assert.match(sha256SumsText(report.artifactHashes), /^[0-9a-f]{64} {2}WorldView-Setup-0\.1\.0-rc\.1\.exe\n$/);

    // A failing test group or provider flips the gate.
    writeFileSync(
      path.join(v, 'tests', 'all.json'),
      JSON.stringify({ fileCount: 99, pass: 450, fail: 4, skipped: 7, ranAt: '2026-09-21T10:00:00Z' }),
    );
    const failed = buildVerificationReport({
      root: dir,
      release: '0.1.0-rc.1',
      artifactsDir: path.join(dir, 'release-out'),
      now: () => 0,
    });
    assert.equal(failed.passed, false);
    assert.ok(failed.knownFailures[0]?.includes('4 failing test'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verification report: the real repository has no failing evidence', () => {
  const report = buildVerificationReport({ root: repoRoot, release: 'dev', now: () => Date.now() });
  // Test-run evidence is whatever the previous run of this very suite wrote (a filtered run
  // with a failure in it, say); it is judged by the run itself, not here.
  assert.deepEqual(
    report.knownFailures.filter((f) => !/failing test\(s\)$/.test(f)),
    [],
  );
  // Provider reports exist only after `pnpm provider:test --all` has run in this checkout (the
  // release gate runs it; a plain `pnpm test` does not). Whatever is there must have passed.
  if (report.providerVerification.length > 0)
    assert.ok(report.providerVerification.length >= 10, `only ${report.providerVerification.length} provider reports`);
  assert.ok(report.providerVerification.every((p) => p.passed));
});
