#!/usr/bin/env node
/**
 * `pnpm release:package` — build the app, seed electron-builder's signing-tool cache,
 * then run it.
 *
 * It builds first because it used to not, and that produced the most expensive lie in this
 * project's history: `release:package` ran electron-builder over whatever `dist/` already
 * held, printed a clean build log, and produced a signed installer carrying a renderer
 * compiled hours earlier. A fix could be written, committed, verified by the whole test
 * suite, packaged "successfully", installed, and launched — and the window would show the
 * bug it had just fixed, because the bundle in the asar predated it. Packaging something
 * other than the current source is not a step that can be allowed to succeed.
 *
 * electron-builder's NSIS path fetches `winCodeSign-2.6.0.7z` and extracts it whole. That
 * archive carries two macOS symlinks:
 *
 *     darwin/10.12/lib/libcrypto.dylib
 *     darwin/10.12/lib/libssl.dylib
 *
 * Creating a symlink on Windows needs SeCreateSymbolicLinkPrivilege, which an ordinary
 * account holds only with Developer Mode on. Without it 7za exits 2, electron-builder
 * retries three more times — re-downloading 5.6 MB each attempt — and the run dies *after*
 * release/win-unpacked has already been packed correctly.
 *
 * Nothing on Windows uses those dylibs; they are there for macOS signing. So this script
 * extracts the same archive first, excluding `darwin`, into the cache directory
 * electron-builder reads. It then finds the cache populated and never downloads or extracts
 * anything, so the privilege never comes up. Developer Mode still works if you have it —
 * this just stops it being required.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appDir, workspaceRoot } from './renderer-assets.mjs';

const require = createRequire(import.meta.url);

/** The exact artifact electron-builder itself fetches — same URL, same version. */
const ARTIFACT = 'winCodeSign-2.6.0';
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${ARTIFACT}/${ARTIFACT}.7z`;
/** Proof the extraction produced the tool the NSIS step actually wants. */
const SENTINEL = path.join('windows-10', 'x64', 'signtool.exe');

/**
 * The cache lives inside the repository rather than %LOCALAPPDATA% so that what
 * electron-builder actually does with it is inspectable — including which directory name
 * it looks for, which is the one thing about this that cannot be read out of its source
 * (the lookup happens inside the `app-builder` Go binary). Gitignored; the environment
 * variable still wins if someone sets it.
 */
const CACHE_ROOT = process.env.ELECTRON_BUILDER_CACHE ?? path.join(appDir, '.electron-builder-cache');

/**
 * `getBin("winCodeSign")` passes no version, so the directory the Go binary settles on is
 * either the artifact name or the bare version. Seeding both costs a few MB of disk and
 * removes the guess.
 */
const CACHE_DIR_CANDIDATES = [ARTIFACT, '2.6.0'];

/** 7zip-bin is a transitive dependency, so resolve it through a package that declares it. */
function find7za() {
  try {
    return require.resolve('7zip-bin/win/x64/7za.exe');
  } catch {
    const pnpmDir = path.join(workspaceRoot, 'node_modules', '.pnpm');
    if (!existsSync(pnpmDir)) return undefined;
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('7zip-bin@')) continue;
      const candidate = path.join(pnpmDir, entry, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
}

async function downloadTo(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, bytes);
  return createHash('sha512').update(bytes).digest('base64');
}

async function seedSignToolCache() {
  const parent = path.join(CACHE_ROOT, 'winCodeSign');
  const dirs = CACHE_DIR_CANDIDATES.map((name) => path.join(parent, name));
  if (dirs.every((dir) => existsSync(path.join(dir, SENTINEL)))) {
    console.log(`[package] signing tools already cached → ${parent}`);
    return;
  }

  const sevenZip = find7za();
  if (!sevenZip) {
    console.warn('[package] could not find 7za.exe; leaving the cache to electron-builder');
    return;
  }

  const archive = path.join(tmpdir(), `${ARTIFACT}.7z`);
  console.log(`[package] fetching ${ARTIFACT} once, without the macOS symlinks Windows cannot create`);
  const sha512 = await downloadTo(URL, archive);
  console.log(`[package] downloaded ${statSync(archive).size} bytes, sha512 ${sha512.slice(0, 16)}…`);

  for (const dir of dirs) {
    if (existsSync(path.join(dir, SENTINEL))) continue;
    mkdirSync(dir, { recursive: true });
    // -xr!darwin drops the only two symlinks in the archive. Everything Windows signing
    // uses lives under windows-10/ and windows-6/.
    const run = spawnSync(sevenZip, ['x', '-bd', '-y', '-xr!darwin', archive, `-o${dir}`], { stdio: 'inherit' });
    if (run.status !== 0 || !existsSync(path.join(dir, SENTINEL))) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(archive, { force: true });
      throw new Error(`could not seed ${dir}: 7za exited ${run.status ?? 'with a signal'} and ${SENTINEL} is missing`);
    }
    console.log(`[package] seeded ${dir}`);
  }
  rmSync(archive, { force: true });
}

try {
  if (process.platform === 'win32') await seedSignToolCache();
} catch (error) {
  // Not fatal: electron-builder will try its own way. It may well fail, but it should fail
  // on its own terms rather than on ours.
  console.warn(
    `[package] could not pre-seed the signing tools (${error instanceof Error ? error.message : String(error)})`,
  );
}

/**
 * Refuse to pack while the previous build is running.
 *
 * Windows keeps a running image open against writes, so electron-builder gets EPERM
 * overwriting release/win-unpacked — but only after minutes of work, and the message
 * names a path, not a cause. Opening the exe for write up front turns that into one line
 * before anything is spent.
 */
function assertPreviousBuildNotRunning() {
  const exe = path.join(appDir, 'release', 'win-unpacked', 'WorldView.exe');
  if (!existsSync(exe)) return;
  try {
    closeSync(openSync(exe, 'r+'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ETXTBSY' && code !== 'EACCES') return;
    console.error(
      '[package] release/win-unpacked/WorldView.exe is locked, which means the packaged app is still running.',
    );
    console.error('[package] Close the WORLDVIEW window and run this again (or: taskkill /F /IM WorldView.exe).');
    process.exit(1);
  }
}

/** Resolve a dependency's own JS entry, for the same reason electron-builder's is resolved. */
function binEntry(pkgName, binName) {
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  const pkg = require(`${pkgName}/package.json`);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName ?? pkgName];
  if (!bin) throw new Error(`${pkgName} declares no bin entry`);
  return path.join(path.dirname(pkgPath), bin);
}

/**
 * Build main and renderer, exactly as `pnpm build` does. Running the steps here rather
 * than telling the operator to run them first is the point: the two cannot drift, and
 * there is no order of commands that packages a stale bundle.
 */
function buildApp() {
  const steps = [
    ['main', [path.join(appDir, 'scripts', 'build-main.mjs')]],
    ['renderer', [binEntry('vite'), 'build', '--config', 'vite.config.ts']],
  ];
  for (const [name, args] of steps) {
    console.log(`[package] building ${name}`);
    const step = spawnSync(process.execPath, args, { cwd: appDir, stdio: 'inherit', env: process.env });
    if (step.error) {
      console.error(`[package] could not start the ${name} build: ${step.error.message}`);
      process.exit(1);
    }
    if (step.status !== 0) {
      console.error(
        `[package] the ${name} build failed (exit ${step.status ?? `signal ${step.signal}`}); nothing was packaged`,
      );
      process.exit(step.status ?? 1);
    }
  }
}

/**
 * Empty the release output before packaging, and stop if it cannot be emptied.
 *
 * electron-builder writes into apps/desktop/release/ beside whatever the last build left, and
 * `pnpm sbom` / `pnpm release:verify` write into artifacts/release/ the same way. rc.4 was
 * released with rc.3's installer, portable zip and SBOM next to its own, all hashed into its
 * SHA256SUMS: nothing ever removed them. A release directory holds one version or it is not
 * a release directory (`pnpm release:assert-version` checks that afterwards).
 */
function cleanReleaseOutput() {
  for (const dir of [path.join(appDir, 'release'), path.join(workspaceRoot, 'artifacts', 'release')]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    } catch (error) {
      console.error(
        `[package] could not empty ${path.relative(workspaceRoot, dir)} (${error instanceof Error ? error.message : String(error)}); nothing was packaged`,
      );
      process.exit(1);
    }
    if (existsSync(dir)) {
      console.error(
        `[package] ${path.relative(workspaceRoot, dir)} is still there after deleting it; nothing was packaged`,
      );
      process.exit(1);
    }
    console.log(`[package] emptied ${path.relative(workspaceRoot, dir)}`);
  }
}

/**
 * The channel a packaged build reports (Diagnostics, the runtime's version info). Nothing set
 * WORLDVIEW_CHANNEL, so every published installer called itself "dev". A package is never a
 * dev build: WORLDVIEW_CHANNEL when the operator sets it, otherwise the version decides — a
 * pre-release version (`0.2.0-rc.1`) is `prerelease`, any other `stable`.
 */
function packagedChannel() {
  const set = process.env.WORLDVIEW_CHANNEL;
  if (set === 'stable' || set === 'prerelease') return set;
  const version = String(require(path.join(appDir, 'package.json')).version ?? '');
  return version.includes('-') ? 'prerelease' : 'stable';
}
process.env.WORLDVIEW_CHANNEL = packagedChannel();
console.log(`[package] channel ${process.env.WORLDVIEW_CHANNEL}`);

assertPreviousBuildNotRunning();
cleanReleaseOutput();
buildApp();

/**
 * Run electron-builder's own JS entry through this Node, not the `.bin` shim: a `.bin`
 * shim is not reliably spawnable on Windows, which is what made `pnpm typecheck` exit 1
 * in total silence until it was resolved the same way.
 */
function electronBuilderEntry() {
  const pkgPath = require.resolve('electron-builder/package.json');
  const pkg = require('electron-builder/package.json');
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['electron-builder'];
  if (!bin) throw new Error('electron-builder declares no bin entry');
  return path.join(path.dirname(pkgPath), bin);
}

const result = spawnSync(
  process.execPath,
  [electronBuilderEntry(), '--config', 'electron-builder.yml', '--win', '--publish', 'never'],
  { cwd: appDir, stdio: 'inherit', env: { ...process.env, ELECTRON_BUILDER_CACHE: CACHE_ROOT } },
);
if (result.error) {
  console.error(`[package] could not start electron-builder: ${result.error.message}`);
  process.exit(1);
}

/**
 * On failure, print what is actually in the cache. The directory name the Go `app-builder`
 * binary looks for is the one thing here that cannot be read out of electron-builder's
 * source, so if it ignored the seed and fetched its own copy, this listing says so outright
 * instead of costing another round of guessing.
 */
if (result.status !== 0) {
  const parent = path.join(CACHE_ROOT, 'winCodeSign');
  console.error(`\n[package] signing-tool cache under ${parent}:`);
  try {
    const entries = readdirSync(parent, { withFileTypes: true });
    if (entries.length === 0) console.error('  (empty)');
    for (const entry of entries) {
      const marker = existsSync(path.join(parent, entry.name, SENTINEL)) ? 'has signtool.exe' : 'no signtool.exe';
      console.error(`  ${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name} — ${marker}`);
    }
  } catch (error) {
    console.error(`  could not read it: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(result.status ?? 1);
