import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every release artifact is the version being released, built from the commit being released.
 *
 * rc.4 went out with rc.3's installer, portable zip and SBOM beside its own: packaging wrote
 * into `apps/desktop/release/` and `artifacts/release/` without emptying them, the SHA256SUMS
 * and verification report hashed whatever was there, and the assets were collected with
 * `*.exe` and `*.sbom.json` globs. Nothing compared a file name with the version.
 *
 * This check does, and fails on any of:
 *  - the tag (when there is one) is not `v<apps/desktop version>`;
 *  - an installer, portable zip, blockmap or SBOM of any other version is present;
 *  - the installer, portable zip or SBOM of this version is missing;
 *  - `latest.yml` names another version or another installer;
 *  - the verification report is for another version or another commit, or hashes another
 *    version's files; SHA256SUMS lists another version's files;
 *  - the SBOM names another version or another commit.
 */
export interface AssertVersionOptions {
  root: string;
  /** The release tag (`v0.1.0-rc.5`), when the build is for one. */
  tag?: string;
  /** HEAD's commit. */
  commit?: string;
  /** Fail when no tag is given (a tagged release build). */
  requireTag?: boolean;
  /** Which platform's package is being checked; Windows unless given (the original release line). */
  platform?: ReleasePlatform;
}

/** `pnpm release:package` packages for the host it runs on (apps/desktop/scripts/platform.mjs). */
export type ReleasePlatform = 'win32' | 'linux';

export interface AssertVersionResult {
  version: string;
  platform: ReleasePlatform;
  ok: boolean;
  problems: string[];
  checked: string[];
}

const ARTIFACT = /\.(exe|zip|blockmap|msi|7z|AppImage|deb|rpm|snap)$/i;

export function expectedArtifacts(version: string): {
  installer: string;
  blockmap: string;
  portable: string;
  sbom: string;
} {
  return {
    installer: `WorldView-Setup-${version}.exe`,
    blockmap: `WorldView-Setup-${version}.exe.blockmap`,
    portable: `WorldView-Portable-${version}.zip`,
    sbom: `WorldView-${version}.sbom.json`,
  };
}

/** The Linux x86_64 package names (electron-builder.yml `deb` and `appImage` artifactName). */
export function expectedLinuxArtifacts(version: string): {
  deb: string;
  appImage: string;
  appImageBlockmap: string;
  sbom: string;
} {
  return {
    deb: `worldview_${version}_amd64.deb`,
    appImage: `WorldView-${version}-x86_64.AppImage`,
    appImageBlockmap: `WorldView-${version}-x86_64.AppImage.blockmap`,
    sbom: `WorldView-${version}.sbom.json`,
  };
}

/** What a release of `version` for `platform` must contain, may contain, and where the updater points. */
interface ReleasePlan {
  allowed: Set<string>;
  required: string[];
  /** electron-updater's feed file and the artifact it must name. */
  updater: { file: string; path: string };
  /** The file the verification report must hash: proof it ran after packaging. */
  primary: string;
  sbom: string;
}

function releasePlan(version: string, platform: ReleasePlatform): ReleasePlan {
  if (platform === 'linux') {
    const l = expectedLinuxArtifacts(version);
    return {
      allowed: new Set([l.deb, l.appImage, l.appImageBlockmap]),
      required: [l.deb, l.appImage],
      updater: { file: 'latest-linux.yml', path: l.appImage },
      primary: l.deb,
      sbom: l.sbom,
    };
  }
  const w = expectedArtifacts(version);
  return {
    allowed: new Set([w.installer, w.blockmap, w.portable]),
    required: [w.installer, w.portable],
    updater: { file: 'latest.yml', path: w.installer },
    primary: w.installer,
    sbom: w.sbom,
  };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function assertReleaseVersion(opts: AssertVersionOptions): AssertVersionResult {
  const problems: string[] = [];
  const checked: string[] = [];
  const desktop = readJson<{ version?: string }>(path.join(opts.root, 'apps', 'desktop', 'package.json'));
  const version = desktop?.version ?? '';
  const platform = opts.platform ?? 'win32';
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    return {
      version,
      platform,
      ok: false,
      problems: [`apps/desktop/package.json version "${version}" is not a semver`],
      checked,
    };
  }
  const plan = releasePlan(version, platform);

  // The tag.
  if (opts.tag) {
    checked.push(`tag ${opts.tag}`);
    if (opts.tag !== `v${version}`) problems.push(`tag ${opts.tag} is not v${version} (apps/desktop/package.json)`);
  } else if (opts.requireTag) problems.push(`no release tag given for version ${version}`);

  // Installers and packages: exactly this version's, for this platform, nothing else.
  const releaseDir = path.join(opts.root, 'apps', 'desktop', 'release');
  const built = list(releaseDir).filter((f) => ARTIFACT.test(f));
  const allowed = plan.allowed;
  for (const f of built) if (!allowed.has(f)) problems.push(`stale or foreign artifact apps/desktop/release/${f}`);
  for (const f of plan.required) if (!built.includes(f)) problems.push(`missing apps/desktop/release/${f}`);
  checked.push(`apps/desktop/release: ${built.length} artifact(s)`);

  // The updater feed (latest.yml on Windows, latest-linux.yml for the AppImage).
  const feed = plan.updater.file;
  const latestFile = path.join(releaseDir, feed);
  if (existsSync(latestFile)) {
    const latest = readFileSync(latestFile, 'utf8');
    const v = /^version:\s*(\S+)\s*$/m.exec(latest)?.[1];
    if (v !== version) problems.push(`${feed} version ${v ?? '(none)'} is not ${version}`);
    const p = /^path:\s*(\S+)\s*$/m.exec(latest)?.[1];
    if (p !== plan.updater.path) problems.push(`${feed} path ${p ?? '(none)'} is not ${plan.updater.path}`);
    checked.push(feed);
  } else if (built.includes(plan.updater.path)) problems.push(`missing apps/desktop/release/${feed}`);

  // SBOM: this version's only, naming this version and commit.
  const outDir = path.join(opts.root, 'artifacts', 'release');
  const sboms = list(outDir).filter((f) => f.endsWith('.sbom.json'));
  for (const f of sboms) if (f !== plan.sbom) problems.push(`stale or foreign SBOM artifacts/release/${f}`);
  const sbom = readJson<{
    metadata?: { component?: { version?: string }; properties?: Array<{ name: string; value: string }> };
  }>(path.join(outDir, plan.sbom));
  if (!sbom) problems.push(`missing artifacts/release/${plan.sbom}`);
  else {
    checked.push(plan.sbom);
    if (sbom.metadata?.component?.version !== version)
      problems.push(`SBOM names version ${sbom.metadata?.component?.version ?? '(none)'}, not ${version}`);
    const sbomCommit = sbom.metadata?.properties?.find((p) => /commit/i.test(p.name))?.value;
    if (opts.commit && sbomCommit && sbomCommit !== opts.commit)
      problems.push(`SBOM is for commit ${sbomCommit}, not ${opts.commit}`);
  }

  // Verification report and SHA256SUMS.
  const report = readJson<{ release?: string; commitSha?: string; artifactHashes?: Array<{ file: string }> }>(
    path.join(outDir, 'verification-report.json'),
  );
  if (!report) problems.push('missing artifacts/release/verification-report.json');
  else {
    checked.push('verification-report.json');
    if (report.release !== version) problems.push(`verification report is for ${report.release}, not ${version}`);
    if (opts.commit && report.commitSha !== opts.commit)
      problems.push(`verification report is for commit ${report.commitSha}, not ${opts.commit}`);
    for (const h of report.artifactHashes ?? [])
      if (ARTIFACT.test(h.file) && !allowed.has(path.basename(h.file)))
        problems.push(`verification report hashes another version's file ${h.file}`);
    if (!(report.artifactHashes ?? []).some((h) => path.basename(h.file) === plan.primary))
      problems.push(`verification report does not hash ${plan.primary} (was it written before packaging?)`);
  }
  const sumsFile = path.join(outDir, 'SHA256SUMS.txt');
  if (existsSync(sumsFile)) {
    checked.push('SHA256SUMS.txt');
    for (const line of readFileSync(sumsFile, 'utf8').split(/\r?\n/)) {
      const file = line.trim().split(/\s+/).slice(1).join(' ').replace(/^\*/, '');
      if (file && ARTIFACT.test(file) && !allowed.has(path.basename(file)))
        problems.push(`SHA256SUMS.txt lists another version's file ${file}`);
    }
  } else problems.push('missing artifacts/release/SHA256SUMS.txt');

  return { version, platform, ok: problems.length === 0, problems, checked };
}

/** The files a release of `version` uploads, by exact path from the repository root. */
export function releaseAssetPaths(version: string, platform: ReleasePlatform = 'win32'): string[] {
  if (platform === 'linux') {
    const l = expectedLinuxArtifacts(version);
    return [
      `apps/desktop/release/${l.deb}`,
      `apps/desktop/release/${l.appImage}`,
      'apps/desktop/release/latest-linux.yml',
      `artifacts/release/${l.sbom}`,
      'artifacts/release/SHA256SUMS.txt',
      'artifacts/release/verification-report.json',
    ];
  }
  const want = expectedArtifacts(version);
  return [
    `apps/desktop/release/${want.installer}`,
    `apps/desktop/release/${want.portable}`,
    'apps/desktop/release/latest.yml',
    `artifacts/release/${want.sbom}`,
    'artifacts/release/SHA256SUMS.txt',
    'artifacts/release/verification-report.json',
  ];
}

export function formatAssertVersion(r: AssertVersionResult): string {
  const lines = [`[release:assert-version] ${r.version} (${r.platform})`];
  for (const c of r.checked) lines.push(`  checked  ${c}`);
  for (const p of r.problems) lines.push(`  FAIL     ${p}`);
  if (r.ok) {
    lines.push('  → PASS: every artifact is this version and this commit');
    lines.push('  upload exactly these (plus THIRD_PARTY_NOTICES.md as THIRD_PARTY_NOTICES.txt):');
    for (const f of releaseAssetPaths(r.version, r.platform)) lines.push(`    ${f}`);
  } else lines.push(`  → FAIL (${r.problems.length})`);
  return lines.join('\n');
}
