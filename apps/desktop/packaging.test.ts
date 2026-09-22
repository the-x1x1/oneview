import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(appDir, rel), 'utf8');
const pkg = JSON.parse(read('package.json')) as { main: string; scripts: Record<string, string>; dependencies: Record<string, string>; author?: string };

/**
 * electron-builder validates its whole configuration before it packages anything, so a
 * single misplaced key costs the entire run. A root-level `zip:` section — which reads
 * perfectly naturally beside `nsis:` — is not in the schema, and `pnpm release:package`
 * died on it without producing a file. These are the root keys electron-builder 25
 * accepts; the per-target sections are a fixed list and `zip` is not one of them.
 */
const VALID_ROOT_KEYS = new Set([
  'afterAllArtifactBuild', 'afterExtract', 'afterPack', 'afterSign', 'apk', 'appId', 'appImage', 'appx',
  'appxManifestCreated', 'artifactBuildCompleted', 'artifactBuildStarted', 'artifactName', 'asar', 'asarUnpack',
  'beforeBuild', 'beforePack', 'buildDependenciesFromSource', 'buildNumber', 'buildVersion', 'compression',
  'copyright', 'cscKeyPassword', 'cscLink', 'deb', 'defaultArch', 'detectUpdateChannel', 'directories',
  'disableDefaultIgnoredFiles', 'disableSanityCheckAsar', 'dmg', 'downloadAlternateFFmpeg', 'electronBranding',
  'electronCompile', 'electronDist', 'electronDownload', 'electronLanguages', 'electronUpdaterCompatibility',
  'electronVersion', 'executableName', 'extends', 'extraFiles', 'extraMetadata', 'extraResources',
  'fileAssociations', 'files', 'flatpak', 'forceCodeSigning', 'framework', 'freebsd',
  'generateUpdatesFilesForAllChannels', 'icon', 'includePdb', 'includeSubNodeModules', 'launchUiVersion',
  'linux', 'mac', 'mas', 'masDev', 'msi', 'msiProjectCreated', 'msiWrapped', 'nativeRebuilder', 'nodeGypRebuild',
  'nodeVersion', 'npmArgs', 'npmRebuild', 'nsis', 'nsisWeb', 'onNodeModuleFile', 'p5p', 'pacman', 'pkg',
  'portable', 'productName', 'protocols', 'publish', 'releaseInfo', 'removePackageKeywords',
  'removePackageScripts', 'rpm', 'snap', 'squirrelWindows', 'target', 'win', '$schema',
]);

/** Top-level keys of a YAML document: a line that starts in column zero with `key:`. */
function rootKeys(yaml: string): string[] {
  return yaml.split(/\r?\n/).flatMap((line) => {
    const m = /^([A-Za-z$][\w$-]*):/.exec(line);
    return m ? [m[1]!] : [];
  });
}

const builderYml = read('electron-builder.yml');

test('electron-builder.yml uses only root keys the schema accepts', () => {
  const unknown = rootKeys(builderYml).filter((k) => !VALID_ROOT_KEYS.has(k));
  assert.deepEqual(unknown, [], `electron-builder rejects these root keys before packaging anything: ${unknown.join(', ')}`);
});

/** The block of lines under a top-level `key:`, up to the next key in column zero. */
function rootBlock(yaml: string, key: string): string {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Za-z$]/.test(l));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}

test('both Windows artifacts get a distinct name', () => {
  // The zip inherits win.artifactName; NSIS overrides it. If they ever collide, one
  // artifact silently overwrites the other in release/.
  const nameOf = (block: string): string | undefined => /artifactName:\s*(\S+)/.exec(block)?.[1];
  const win = nameOf(rootBlock(builderYml, 'win'));
  const nsis = nameOf(rootBlock(builderYml, 'nsis'));
  assert.ok(win, 'win.artifactName is what the zip target uses');
  assert.ok(nsis, 'nsis.artifactName names the installer');
  assert.notEqual(win, nsis);
});

test('electron-builder has the metadata it warns about', () => {
  // "author is missed in the package.json" — it becomes the installer's publisher.
  assert.ok(pkg.author, 'apps/desktop/package.json needs an author; it is the NSIS publisher');
});

/**
 * `dependencies` here is not a list of what the app uses — esbuild and Vite bundle almost
 * all of that — it is the exact set electron-builder copies into the package and the app
 * `require`s at run time. Keeping it minimal is not tidiness; two separate packaging
 * failures came from getting it wrong in opposite directions.
 *
 * Too few: `@duckdb/node-api` was external, unpacked by name in `asarUnpack`, and declared
 * nowhere but as an optional peer of packages/history-store, so it would not have shipped.
 *
 * Too many: every `@worldview/*` workspace package sat here, and electron-builder resolved
 * each symlink to `worldview/packages/<name>`. Its `getRelativePath` tolerates a path
 * outside the app directory *only* when the path contains a `node_modules` segment — which
 * is why pnpm's `.pnpm/<pkg>/node_modules/<pkg>` layout works for ordinary dependencies and
 * a workspace link does not. Packaging died with "packages/camera-gateway/package.json must
 * be under apps/desktop/".
 */
const EXEMPT_EXTERNALS = new Set([
  // Supplied by the Electron runtime itself; never packaged from node_modules.
  'electron',
  // Arrives as a dependency of @duckdb/node-api, which the app does declare. Listed
  // external only so esbuild does not try to bundle a native module.
  '@duckdb/node-bindings',
]);

function mainBundleExternals(): string[] {
  const buildMain = read('scripts/build-main.mjs');
  return (/external:\s*\[([^\]]+)\]/.exec(buildMain)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .filter((m) => !EXEMPT_EXTERNALS.has(m));
}

test('every module the main bundle leaves external is a declared dependency', () => {
  const externals = mainBundleExternals();
  assert.ok(externals.length > 0, 'expected build-main.mjs to declare externals');
  for (const mod of externals) {
    const declared = mod in pkg.dependencies || Object.keys(pkg.dependencies).some((d) => mod.startsWith(`${d}/`));
    assert.ok(declared, `${mod} is required at run time but apps/desktop does not declare it, so it would not be packaged`);
  }
});

test('nothing bundled is left in dependencies', () => {
  const externals = new Set(mainBundleExternals());
  const extra = Object.keys(pkg.dependencies).filter((d) => !externals.has(d));
  assert.deepEqual(extra, [], `these are bundled by esbuild or Vite, so shipping them in the package is dead weight at best: ${extra.join(', ')}`);
});

test('no production dependency is a workspace link', () => {
  // electron-builder resolves the symlink to worldview/packages/<name>, a path with no
  // node_modules segment, and throws before producing anything.
  const workspaceLinks = Object.entries(pkg.dependencies).filter(([, v]) => v.startsWith('workspace:')).map(([k]) => k);
  assert.deepEqual(workspaceLinks, [], `electron-builder cannot pack a workspace link: ${workspaceLinks.join(', ')}`);
});

test('package.json main points at what the build actually emits', () => {
  assert.equal(pkg.main, 'dist/main/main.cjs');
  assert.match(read('scripts/build-main.mjs'), /'dist',\s*'main',\s*'main\.cjs'/);
});

/**
 * Electron loads DEV_SERVER_ORIGIN in dev. Vite binds what vite.config.ts says. If those
 * disagree the window comes up blank, and on Windows they disagree invisibly: Vite binds
 * 127.0.0.1 while "localhost" resolves to ::1 first, so the connection is refused.
 */
test('the dev server address the main process trusts is the one Vite binds', () => {
  const origin = /DEV_SERVER_ORIGIN\s*=\s*'([^']+)'/.exec(read('src/shared/app-origin.ts'))?.[1];
  assert.ok(origin, 'DEV_SERVER_ORIGIN not found');
  const { hostname, port } = new URL(origin);
  const viteConfig = read('vite.config.ts');
  assert.equal(/host:\s*'([^']+)'/.exec(viteConfig)?.[1], hostname, 'vite server.host must match DEV_SERVER_ORIGIN');
  assert.equal(/port:\s*(\d+)/.exec(viteConfig)?.[1], port, 'vite server.port must match DEV_SERVER_ORIGIN');
  assert.notEqual(hostname, 'localhost', 'on Windows "localhost" resolves to ::1 before 127.0.0.1, which Vite is not listening on');
});

test('pnpm dev launches Electron, which is what DEVELOPMENT.md promises', () => {
  assert.equal(pkg.scripts.dev, 'node scripts/dev.mjs');
  const dev = read('scripts/dev.mjs');
  assert.match(dev, /require\('electron'\)/, 'nothing in the repo launched Electron for a long time; keep it launched here');
  assert.match(dev, /WORLDVIEW_DEV/, 'main.ts only enters dev mode when WORLDVIEW_DEV=1');
  assert.doesNotMatch(pkg.scripts.dev, /&/, 'pnpm runs scripts through cmd.exe on Windows, where & is sequential, not background');
});

/**
 * `pnpm release:package` failed four runs in a row on an account privilege rather than
 * anything in this repository, so the guard is on the workaround staying intact.
 */
test('packaging seeds the signing tools instead of requiring the symlink privilege', () => {
  assert.equal(pkg.scripts.package, 'node scripts/package.mjs');
  const script = read('scripts/package.mjs');

  // The two macOS symlinks are the entire problem; excluding them is the entire fix.
  assert.match(script, /-xr!darwin/, 'the darwin directory holds the only symlinks in the archive');
  assert.match(script, /winCodeSign-2\.6\.0/, 'the artifact electron-builder itself fetches');
  assert.match(script, /windows-10.*x64.*signtool\.exe|SENTINEL/, 'verify the extraction produced the tool NSIS wants');

  // Same trap as tsc and Electron: a .bin shim is not reliably spawnable on Windows.
  assert.doesNotMatch(script, /node_modules['"\s,)]*,?\s*['"]\.bin['"]/, 'run electron-builder through its JS entry, not the .bin shim');
  assert.match(script, /electronBuilderEntry/, 'resolve electron-builder by package entry');

  // The child must read the same cache this script seeded, or the seeding is pointless.
  assert.match(script, /ELECTRON_BUILDER_CACHE: CACHE_ROOT/);
});
