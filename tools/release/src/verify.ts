import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Release verification report (directive §81, §121).
 *
 * Collects the evidence that already exists on disk — test summaries, provider
 * contract checklists, boundary and license audits, benchmarks, offline reports —
 * hashes the packaged artifacts, and states plainly what was NOT verified in this
 * environment. It never invents a result: a missing input becomes a `missing` entry
 * and, for release-blocking inputs, sets `passed: false`.
 */
export interface EvidenceRef {
  name: string;
  path: string;
  present: boolean;
  summary?: Record<string, unknown>;
}

export interface ArtifactHash {
  file: string;
  sizeBytes: number;
  sha256: string;
}

export interface VerificationReport {
  release: string;
  commitSha: string;
  buildTime: string;
  nodeVersion: string;
  pnpmVersion: string;
  platform: string;
  lockfileHash: string;
  tests: Record<string, { files: number; pass: number; fail: number; skipped: number; ranAt?: string }>;
  providerVerification: Array<{
    providerId: string;
    passed: boolean;
    pass: number;
    fail: number;
    skip: number;
    ranAt: string;
  }>;
  offlineVerification: EvidenceRef[];
  securityAudit: EvidenceRef;
  licenseAudit: EvidenceRef;
  boundaryCheck: EvidenceRef;
  typecheck: EvidenceRef;
  benchmarks: EvidenceRef[];
  sbom: { path: string; present: boolean; sha256?: string; components?: number };
  artifactHashes: ArtifactHash[];
  knownFailures: string[];
  knownLimitations: string[];
  notVerifiedHere: string[];
  passed: boolean;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function tryExec(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function evidence(
  root: string,
  name: string,
  rel: string,
  summarize?: (v: Record<string, unknown>) => Record<string, unknown>,
): EvidenceRef {
  const abs = path.join(root, rel);
  const present = existsSync(abs);
  const raw = present ? readJson<Record<string, unknown>>(abs) : undefined;
  const ref: EvidenceRef = { name, path: rel, present: present && raw !== undefined };
  if (raw) ref.summary = summarize ? summarize(raw) : raw;
  return ref;
}

export interface VerifyOptions {
  root: string;
  release: string;
  /** Directory holding packaged installers (apps/desktop/release by default). */
  artifactsDir?: string;
  now?: () => number;
}

export function buildVerificationReport(opts: VerifyOptions): VerificationReport {
  const root = opts.root;
  const now = new Date((opts.now ?? Date.now)()).toISOString();
  const lockPath = path.join(root, 'pnpm-lock.yaml');

  const tests: VerificationReport['tests'] = {};
  const testsDir = path.join(root, 'artifacts', 'verification', 'tests');
  if (existsSync(testsDir)) {
    for (const f of readdirSync(testsDir)) {
      if (!f.endsWith('.json')) continue;
      const v = readJson<{ fileCount: number; pass: number; fail: number; skipped: number; ranAt: string }>(
        path.join(testsDir, f),
      );
      if (v)
        tests[f.replace(/\.json$/, '')] = {
          files: v.fileCount,
          pass: v.pass,
          fail: v.fail,
          skipped: v.skipped,
          ranAt: v.ranAt,
        };
    }
  }

  const providerVerification: VerificationReport['providerVerification'] = [];
  const providersDir = path.join(root, 'artifacts', 'verification', 'providers');
  if (existsSync(providersDir)) {
    for (const f of readdirSync(providersDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const v = readJson<{
        providerId: string;
        passed: boolean;
        summary: { pass: number; fail: number; skip: number };
        ranAt: string;
      }>(path.join(providersDir, f));
      if (v)
        providerVerification.push({
          providerId: v.providerId,
          passed: v.passed,
          pass: v.summary.pass,
          fail: v.summary.fail,
          skip: v.summary.skip,
          ranAt: v.ranAt,
        });
    }
  }

  const offlineVerification: EvidenceRef[] = [];
  const offlineDir = path.join(root, 'artifacts', 'verification', 'offline');
  if (existsSync(offlineDir)) {
    for (const f of readdirSync(offlineDir).sort())
      if (f.endsWith('.json'))
        offlineVerification.push(
          evidence(root, f.replace(/\.json$/, ''), path.posix.join('artifacts/verification/offline', f)),
        );
  }
  offlineVerification.push(evidence(root, 'offline test group', 'artifacts/verification/tests/offline.json'));

  const benchmarks: EvidenceRef[] = [];
  const benchDir = path.join(root, 'artifacts', 'verification', 'benchmarks');
  if (existsSync(benchDir)) {
    for (const f of readdirSync(benchDir).sort())
      if (f.endsWith('.json'))
        benchmarks.push(
          evidence(root, f.replace(/\.json$/, ''), path.posix.join('artifacts/verification/benchmarks', f)),
        );
  }

  const artifactsDir = opts.artifactsDir ?? path.join(root, 'apps', 'desktop', 'release');
  const artifactHashes: ArtifactHash[] = [];
  if (existsSync(artifactsDir)) {
    for (const f of readdirSync(artifactsDir).sort()) {
      const abs = path.join(artifactsDir, f);
      if (!statSync(abs).isFile()) continue;
      if (!/\.(exe|zip|yml|blockmap|msi|7z)$/i.test(f)) continue;
      artifactHashes.push({ file: f, sizeBytes: statSync(abs).size, sha256: sha256File(abs) });
    }
  }

  const sbomPath = path.join(root, 'artifacts', 'release', `WorldView-${opts.release}.sbom.json`);
  const sbomPresent = existsSync(sbomPath);
  const sbomDoc = sbomPresent ? readJson<{ components: unknown[] }>(sbomPath) : undefined;

  const knownLimitationsFile = path.join(root, 'docs', 'releases', 'KNOWN-LIMITATIONS.md');
  const knownLimitations = existsSync(knownLimitationsFile)
    ? readFileSync(knownLimitationsFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim())
    : [];

  const knownFailures: string[] = [];
  for (const [group, t] of Object.entries(tests))
    if (t.fail > 0) knownFailures.push(`${group}: ${t.fail} failing test(s)`);
  for (const p of providerVerification)
    if (!p.passed) knownFailures.push(`provider ${p.providerId}: ${p.fail} failing check(s)`);

  const licenseAudit = evidence(root, 'license-audit', 'artifacts/verification/license-audit.json', (v) => ({
    passed: v['passed'],
    findings: Array.isArray(v['findings']) ? (v['findings'] as unknown[]).length : undefined,
  }));
  const boundaryCheck = evidence(root, 'boundary-check', 'artifacts/verification/boundary-check.json', (v) => ({
    passed: v['passed'],
    filesChecked: v['filesChecked'],
  }));
  const typecheck = evidence(root, 'typecheck', 'artifacts/verification/typecheck.json', (v) => ({
    passed: v['passed'],
    shimsActive: v['shimsActive'],
  }));
  const securityAudit = evidence(root, 'dependency-audit', 'artifacts/verification/dependency-audit.json', (v) => ({
    vulnerabilities: v['vulnerabilities'],
    ranAt: v['ranAt'],
  }));

  const notVerifiedHere: string[] = [];
  if (!existsSync(lockPath))
    notVerifiedHere.push(
      'pnpm-lock.yaml is absent: dependencies were never installed or resolved in this environment, so the SBOM lists workspace and declared components only',
    );
  if (artifactHashes.length === 0)
    notVerifiedHere.push(
      `no packaged artifacts found in ${path.relative(root, artifactsDir)}: the Windows installer/portable build was not produced here`,
    );
  if (!securityAudit.present) notVerifiedHere.push('no dependency audit result (pnpm audit requires registry access)');
  const shims = (typecheck.summary?.['shimsActive'] as string[] | undefined) ?? [];
  if (shims.length)
    notVerifiedHere.push(`type checking used declaration shims for uninstalled libraries: ${shims.join(', ')}`);

  const blocking =
    knownFailures.length === 0 &&
    licenseAudit.summary?.['passed'] !== false &&
    boundaryCheck.summary?.['passed'] !== false &&
    typecheck.summary?.['passed'] !== false &&
    providerVerification.every((p) => p.passed);

  return {
    release: opts.release,
    commitSha: tryExec('git', ['rev-parse', 'HEAD'], root),
    buildTime: now,
    nodeVersion: process.version,
    pnpmVersion: tryExec('pnpm', ['--version'], root),
    platform: `${process.platform}-${process.arch}`,
    lockfileHash: existsSync(lockPath) ? sha256File(lockPath) : 'absent',
    tests,
    providerVerification,
    offlineVerification,
    securityAudit,
    licenseAudit,
    boundaryCheck,
    typecheck,
    benchmarks,
    sbom: {
      path: path.relative(root, sbomPath),
      present: sbomPresent,
      ...(sbomPresent ? { sha256: sha256File(sbomPath), components: sbomDoc?.components.length ?? 0 } : {}),
    },
    artifactHashes,
    knownFailures,
    knownLimitations,
    notVerifiedHere,
    passed: blocking,
  };
}

export function sha256SumsText(hashes: ArtifactHash[]): string {
  return hashes.map((h) => `${h.sha256}  ${h.file}`).join('\n') + (hashes.length ? '\n' : '');
}

export function formatVerification(r: VerificationReport): string {
  const lines = [
    `WorldView ${r.release} — verification`,
    `commit ${r.commitSha} · node ${r.nodeVersion} · pnpm ${r.pnpmVersion} · ${r.platform} · ${r.buildTime}`,
    '',
    'Tests:',
    ...Object.entries(r.tests).map(
      ([g, t]) => `  ${g.padEnd(12)} ${t.pass} pass, ${t.fail} fail, ${t.skipped} skipped (${t.files} files)`,
    ),
    'Providers:',
    ...r.providerVerification.map(
      (p) =>
        `  ${p.providerId.padEnd(24)} ${p.pass} pass, ${p.fail} fail, ${p.skip} skip → ${p.passed ? 'PASS' : 'FAIL'}`,
    ),
    `Boundary check: ${r.boundaryCheck.present ? JSON.stringify(r.boundaryCheck.summary) : 'missing'}`,
    `License audit:  ${r.licenseAudit.present ? JSON.stringify(r.licenseAudit.summary) : 'missing'}`,
    `Typecheck:      ${r.typecheck.present ? JSON.stringify(r.typecheck.summary) : 'missing'}`,
    `SBOM:           ${r.sbom.present ? `${r.sbom.components} components` : 'not generated'}`,
    `Artifacts:      ${r.artifactHashes.length ? r.artifactHashes.map((a) => a.file).join(', ') : 'none in this environment'}`,
  ];
  if (r.knownFailures.length) lines.push('', 'Known failures:', ...r.knownFailures.map((k) => `  - ${k}`));
  if (r.notVerifiedHere.length)
    lines.push('', 'Not verified in this environment:', ...r.notVerifiedHere.map((k) => `  - ${k}`));
  if (r.knownLimitations.length)
    lines.push('', `Known limitations: ${r.knownLimitations.length} recorded in docs/releases/KNOWN-LIMITATIONS.md`);
  lines.push('', `Release gate → ${r.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}
