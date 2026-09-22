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
 * Anything esbuild leaves `external` is `require`d from node_modules at run time, and
 * electron-builder ships the *app's* production dependencies. `@duckdb/node-api` was
 * external, unpacked by name in asarUnpack, and declared nowhere but as an optional peer
 * of packages/history-store — so it lived in that package's node_modules and would not
 * have been packaged. Same shape as cesium and maplibre-gl before it.
 */
const EXEMPT_EXTERNALS = new Set([
  // Supplied by the Electron runtime itself; never packaged from node_modules.
  'electron',
  // Arrives as a dependency of @duckdb/node-api, which the app does declare. Listed
  // external only so esbuild does not try to bundle a native module.
  '@duckdb/node-bindings',
]);

test('every module the main bundle leaves external is a declared dependency', () => {
  const buildMain = read('scripts/build-main.mjs');
  const externals = (/external:\s*\[([^\]]+)\]/.exec(buildMain)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .filter((m) => !EXEMPT_EXTERNALS.has(m));
  assert.ok(externals.length > 0, 'expected build-main.mjs to declare externals');
  for (const mod of externals) {
    const declared = mod in pkg.dependencies || Object.keys(pkg.dependencies).some((d) => mod.startsWith(`${d}/`));
    assert.ok(declared, `${mod} is required at run time but apps/desktop does not declare it, so it would not be packaged`);
  }
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
