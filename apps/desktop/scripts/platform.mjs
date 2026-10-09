/**
 * What packaging and development need to know about the operating system they run on.
 *
 * electron-builder only builds for the platform it runs on here (Windows on Windows, Linux on
 * Linux): cross-building a Linux AppImage from Windows needs Docker, and a Windows installer
 * from Linux needs Wine, and neither is something this project should depend on. So the
 * target is the host, and a host this project does not package for stops in one line.
 *
 * Pure functions only, so packaging.test.ts can check every branch on any machine.
 */

/** @typedef {{ platform: 'win32' | 'linux', flag: string, unpackedDir: string, executable: string, label: string }} PackageTarget */

/** @type {Record<'win32' | 'linux', PackageTarget>} */
export const PACKAGE_TARGETS = {
  win32: {
    platform: 'win32',
    flag: '--win',
    unpackedDir: 'win-unpacked',
    executable: 'WorldView.exe',
    label: 'Windows x64 (NSIS installer + portable zip)',
  },
  linux: {
    platform: 'linux',
    flag: '--linux',
    unpackedDir: 'linux-unpacked',
    // linux.executableName in electron-builder.yml; the .deb links /usr/bin/worldview to it.
    executable: 'worldview',
    label: 'Linux x86_64 (.deb)',
  },
};

/**
 * The target for this host, or the reason there is none.
 * @param {string} platform process.platform
 * @param {string} arch process.arch
 * @returns {{ ok: true, target: PackageTarget } | { ok: false, reason: string }}
 */
export function packageTargetFor(platform, arch) {
  const target = PACKAGE_TARGETS[/** @type {'win32' | 'linux'} */ (platform)];
  if (!target) {
    return {
      ok: false,
      reason: `WorldView is packaged on Windows or Linux; this is ${platform}. Nothing was packaged.`,
    };
  }
  if (arch !== 'x64') {
    return {
      ok: false,
      reason: `WorldView is packaged for x64 only; this machine is ${arch}. Nothing was packaged.`,
    };
  }
  return { ok: true, target };
}

/**
 * Why Electron's sandbox will not start on this Linux machine, with the fix, or undefined.
 *
 * Chromium sandboxes its renderers with unprivileged user namespaces, or failing that a
 * setuid `chrome-sandbox` helper. Ubuntu 23.10 and later (24.04, 26.04) block unprivileged
 * user namespaces through AppArmor unless a profile allows them for that binary
 * (kernel.apparmor_restrict_unprivileged_userns = 1). The .deb installs such a profile for
 * /opt/WorldView/worldview; the Electron binary `pnpm dev` runs from node_modules has none,
 * and its chrome-sandbox is not setuid, so Electron aborts with "The SUID sandbox helper
 * binary was found, but is not configured correctly".
 *
 * The answer is never --no-sandbox. It is to make the helper setuid root (what Chromium's
 * own Linux packages do) or to give the binary an AppArmor profile; this says which, with
 * the exact path.
 *
 * @param {{ restrictUserns: string | undefined, sandboxPath: string, sandbox: { uid: number, mode: number } | undefined }} probe
 * @returns {string | undefined}
 */
export function linuxSandboxProblem(probe) {
  if (probe.restrictUserns?.trim() !== '1') return undefined;
  const s = probe.sandbox;
  if (s && s.uid === 0 && (s.mode & 0o4000) !== 0) return undefined;
  return [
    'Electron will probably not start its sandbox: this system restricts unprivileged user namespaces',
    '(kernel.apparmor_restrict_unprivileged_userns = 1, the Ubuntu 24.04+ default) and the',
    "development Electron's chrome-sandbox helper is not setuid root.",
    'Fix it once for this checkout (re-run after Electron is reinstalled):',
    `  sudo chown root:root '${probe.sandboxPath}'`,
    `  sudo chmod 4755 '${probe.sandboxPath}'`,
    'WorldView never runs with --no-sandbox. The installed .deb does not need this: it ships',
    'an AppArmor profile for its own binary. See docs/cyberdeck/LINUX.md.',
  ].join('\n');
}
