export interface PackageTarget {
  platform: 'win32' | 'linux';
  flag: string;
  unpackedDir: string;
  executable: string;
  label: string;
}

export declare const PACKAGE_TARGETS: Record<'win32' | 'linux', PackageTarget>;

export declare function packageTargetFor(
  platform: string,
  arch: string,
): { ok: true; target: PackageTarget } | { ok: false; reason: string };

export declare function linuxSandboxProblem(probe: {
  restrictUserns: string | undefined;
  sandboxPath: string;
  sandbox: { uid: number; mode: number } | undefined;
}): string | undefined;
