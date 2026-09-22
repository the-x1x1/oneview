#!/usr/bin/env node
/**
 * `pnpm release:package` — seed electron-builder's signing-tool cache, then run it.
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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appDir, workspaceRoot } from './cesium-assets.mjs';

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
  console.warn(`[package] could not pre-seed the signing tools (${error instanceof Error ? error.message : String(error)})`);
}

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
