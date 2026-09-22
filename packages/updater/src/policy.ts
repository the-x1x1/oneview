import type { AppSettings } from '@worldview/ipc-contract';

/**
 * Update trust policy (ADR-012).
 *
 *  - unsigned build → check + notify only; never download or install in the background
 *  - signed + automatic → background download, install on quit
 *  - signed + manual → check + notify, download on explicit request
 *  - prerelease channel only when the user opted in; a prerelease can never replace a
 *    stable install otherwise (the controller re-checks this even if the update feed
 *    misbehaves)
 *  - `install` is always an explicit user action
 */
export type UpdateChannel = 'stable' | 'prerelease';

export interface UpdatePolicyInput {
  channel: UpdateChannel;
  /** User setting: background download + install on quit (only honoured when signed). */
  automatic: boolean;
  /** Injected by the build: true only when the running binary carries a valid code signature. */
  signed: boolean;
  /** False for unpackaged/dev runs — no update checks at all. */
  packaged: boolean;
}

export interface UpdatePolicyDecision {
  enabled: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /** Always true: the UI must present install as a button, never a timer. */
  installRequiresUserAction: true;
  /** Human-readable summary shown in Settings → Updates and in diagnostics. */
  reason: string;
}

export function resolveUpdatePolicy(input: UpdatePolicyInput): UpdatePolicyDecision {
  const allowPrerelease = input.channel === 'prerelease';
  if (!input.packaged) {
    return {
      enabled: false,
      allowPrerelease,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      installRequiresUserAction: true,
      reason: 'update checks are disabled for unpackaged (development) runs',
    };
  }
  if (!input.signed) {
    return {
      enabled: true,
      allowPrerelease,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      installRequiresUserAction: true,
      reason: 'unsigned build: updates are checked and shown, never downloaded or installed automatically',
    };
  }
  if (input.automatic) {
    return {
      enabled: true,
      allowPrerelease,
      autoDownload: true,
      autoInstallOnAppQuit: true,
      installRequiresUserAction: true,
      reason: `signed build, automatic updates on (${input.channel} channel): downloaded in the background, installed when you quit or on request`,
    };
  }
  return {
    enabled: true,
    allowPrerelease,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    installRequiresUserAction: true,
    reason: `signed build, automatic updates off (${input.channel} channel): you will be told when an update exists`,
  };
}

/** Channel + automatic flag are derived from AppSettings; the signed flag is injected by the build. */
export function policyInputFromSettings(
  updater: AppSettings['updater'],
  build: { signed: boolean; packaged: boolean },
): UpdatePolicyInput {
  return {
    channel: updater.prerelease ? 'prerelease' : 'stable',
    automatic: updater.automatic,
    signed: build.signed,
    packaged: build.packaged,
  };
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(v: string): ParsedVersion | undefined {
  const m = SEMVER.exec(v.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [] };
}

export function isPrereleaseVersion(v: string): boolean {
  const p = parseVersion(v);
  return p !== undefined && p.prerelease.length > 0;
}

/** Semver precedence: negative when a < b, positive when a > b, 0 when equal. Unparseable versions compare as equal (never an upgrade). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) if (pa[key] !== pb[key]) return pa[key] - pb[key];
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx - ny;
      continue;
    }
    if (nx !== undefined) return -1;
    if (ny !== undefined) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether an offered version may be applied on top of the current one under the policy.
 * Never a downgrade; never a prerelease unless the channel allows it.
 */
export function isAcceptableUpdate(
  current: string,
  offered: string,
  decision: Pick<UpdatePolicyDecision, 'allowPrerelease'>,
): { ok: boolean; reason?: string } {
  if (compareVersions(offered, current) <= 0)
    return { ok: false, reason: `offered ${offered} is not newer than ${current}` };
  if (isPrereleaseVersion(offered) && !decision.allowPrerelease)
    return { ok: false, reason: `${offered} is a prerelease and the prerelease channel is not enabled` };
  return { ok: true };
}
