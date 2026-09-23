/**
 * Where the renderers' static assets come from, and where they are staged.
 *
 * Cesium loads Workers, Assets, ThirdParty and Widgets over HTTP at run time from
 * `CESIUM_BASE_URL` (see vite.config.ts), so they cannot be bundled — they have to sit
 * next to index.html as real files.
 *
 * They are staged into a *Vite public directory* rather than written straight into
 * `dist/renderer`, because `vite build` empties its own outDir. The previous arrangement
 * copied them into dist/renderer and then vite deleted them moments later: the build
 * printed "copied Cesium assets" and the finished dist/renderer contained only
 * `index.html` and `assets/`. Vite copies its publicDir into outDir *after* emptying, so
 * staging is the step that survives.
 *
 * Both the build script and both Vite configs import the path from here, so the two
 * halves cannot drift apart again.
 *
 * The source is the `cesium` package's combined build, while the renderer imports
 * `@cesium/engine` (see packages/render-cesium/src/cesium-module.ts). That split is
 * deliberate: the combined build is the only place the third-party wasm ships complete
 * (draco_decoder, basis_transcoder, zip-module, wasm_splats — @cesium/engine's own
 * Build/ThirdParty holds Workers alone), and `Widgets/widgets.css` here is the
 * stylesheet index.html links so CesiumWidget's canvas fills its container. All of it is
 * data: no file staged from this directory is imported as a module, so @cesium/widgets'
 * JavaScript — and the Knockout eval that blanked the window — stays out of the bundle.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, '..');
export const workspaceRoot = path.resolve(appDir, '..', '..');

/** Staging directory; served at `/` in dev and copied into dist/renderer on build. */
export const VITE_PUBLIC_DIR = path.join(appDir, '.vite-public');
/** `CESIUM_BASE_URL` is './cesium', so the assets live one level down. */
export const CESIUM_PUBLIC_DIR = path.join(VITE_PUBLIC_DIR, 'cesium');
export const CESIUM_SUBDIRS = ['Workers', 'Assets', 'ThirdParty', 'Widgets'];
/** MapLibre's stylesheet is staged beside Cesium's, and for the same reason — see below. */
export const MAPLIBRE_PUBLIC_DIR = path.join(VITE_PUBLIC_DIR, 'maplibre');

/**
 * pnpm does not hoist: cesium is a dependency of apps/desktop and lives in
 * apps/desktop/node_modules, not the workspace root. Looking only at the root meant this
 * step warned and skipped on every real install.
 */
export function packageFileCandidates(pkg, relative) {
  const searchDirs = [appDir, workspaceRoot];
  for (const group of ['packages', 'providers']) {
    const groupDir = path.join(workspaceRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) searchDirs.push(path.join(groupDir, entry.name));
    }
  }
  return searchDirs.map((dir) => path.join(dir, 'node_modules', ...pkg.split('/'), relative));
}

export function cesiumBuildDirCandidates() {
  const searchDirs = [appDir, workspaceRoot];
  for (const group of ['packages', 'providers']) {
    const groupDir = path.join(workspaceRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) searchDirs.push(path.join(groupDir, entry.name));
    }
  }
  return searchDirs.map((dir) => path.join(dir, 'node_modules', 'cesium', 'Build', 'Cesium'));
}

export function findCesiumBuildDir() {
  return cesiumBuildDirCandidates().find((c) => existsSync(c));
}

/**
 * Stage the assets. Returns the staged directory, or throws with the places it looked —
 * a missing Cesium must fail the build, not warn in the middle of a successful one.
 */
export function stageCesiumAssets() {
  const source = findCesiumBuildDir();
  if (!source) {
    throw new Error(
      `cesium assets not found (looked in ${cesiumBuildDirCandidates().join(', ')}); the 3D globe cannot load without them`,
    );
  }
  rmSync(CESIUM_PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(CESIUM_PUBLIC_DIR, { recursive: true });
  for (const sub of CESIUM_SUBDIRS)
    cpSync(path.join(source, sub), path.join(CESIUM_PUBLIC_DIR, sub), { recursive: true });
  const missing = CESIUM_SUBDIRS.filter((sub) => !existsSync(path.join(CESIUM_PUBLIC_DIR, sub)));
  if (missing.length)
    throw new Error(`cesium assets staged but incomplete: ${missing.join(', ')} missing from ${CESIUM_PUBLIC_DIR}`);
  return CESIUM_PUBLIC_DIR;
}

/**
 * Where MapLibre's module worker is served from, relative to index.html. The renderer hands
 * this to `setWorkerUrl` (packages/render-maplibre `loadMapLibre`, called from
 * src/renderer/main.tsx); `renderer-assets.test.ts` asserts the two spellings agree, because
 * a renderer pointing at one path while the build stages another is exactly the failure
 * this exists to end.
 */
export const MAPLIBRE_WORKER_PATH = 'maplibre/maplibre-gl-worker.mjs';

/** The files MapLibre loads at run time rather than through the bundle. */
export const MAPLIBRE_RUNTIME_FILES = ['maplibre-gl.css', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

/**
 * The maplibre-gl package the renderer bundle is actually built from.
 *
 * `import('maplibre-gl')` lives in packages/render-maplibre, and Vite resolves it from
 * there, so that package's `node_modules/maplibre-gl` link is the one whose code ships. The
 * worker has to come from the same place: the main thread and the worker talk over a
 * message protocol that is not stable across versions, and this workspace has had two
 * maplibre-gl versions installed at once (5.24.0 alongside 6.10.0). Searching candidate
 * directories in order would happily stage a stylesheet from one and a worker from the
 * other.
 */
export function maplibrePackageDir() {
  const link = path.join(workspaceRoot, 'packages', 'render-maplibre', 'node_modules', 'maplibre-gl');
  if (!existsSync(link)) {
    const fallback = packageFileCandidates('maplibre-gl', 'package.json').find((c) => existsSync(c));
    if (!fallback) throw new Error(`maplibre-gl is not installed (looked for ${link})`);
    return path.dirname(fallback);
  }
  return realpathSync(link);
}

/**
 * MapLibre's stylesheet and its module worker, staged rather than imported.
 *
 * The stylesheet: `maplibre-gl` positions its canvas and its controls entirely from CSS —
 * `.maplibregl-map { position: relative }`, `.maplibregl-canvas { position: absolute }`,
 * and every control, popup and attribution rule. Nothing in this repository imported it,
 * so 2D had been running without it since the adapter was written. It is linked from
 * index.html rather than imported through the bundler because the workspace type-checks
 * with `maplibre-gl` mapped to a declaration shim where the package is not installed, and
 * a deep import of a .css file under that mapping does not resolve.
 *
 * The worker: maplibre-gl 6 stopped inlining its worker. It ships
 * `maplibre-gl-worker.mjs` (which imports `./maplibre-gl-shared.mjs`) and finds it from
 * `import.meta.url` — but only when that URL is http(s). Under `worldview://app` its lookup
 * returns an empty string, `new Worker("", { type: "module" })` loads the document itself,
 * the protocol answers `/` with index.html, and Chromium reports "Failed to load module
 * script: … MIME type of text/html". Vite never emitted the worker either, because nothing
 * it can see references it. The upgrade from 5.24 to 6.10 was made for a security advisory,
 * passed every test, and left the packaged 2D map without the worker that parses its
 * GeoJSON sources and tiles. Both files are staged side by side so the worker's relative
 * import resolves, and the renderer calls `setWorkerUrl` with `MAPLIBRE_WORKER_PATH`.
 */
export function stageMapLibreAssets() {
  const pkgDir = maplibrePackageDir();
  const version = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  const missing = MAPLIBRE_RUNTIME_FILES.filter((f) => !existsSync(path.join(pkgDir, 'dist', f)));
  if (missing.length) {
    throw new Error(
      `maplibre-gl ${version} at ${pkgDir} lacks ${missing.join(', ')}; the 2D map cannot run without them`,
    );
  }
  rmSync(MAPLIBRE_PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(MAPLIBRE_PUBLIC_DIR, { recursive: true });
  for (const f of MAPLIBRE_RUNTIME_FILES) cpSync(path.join(pkgDir, 'dist', f), path.join(MAPLIBRE_PUBLIC_DIR, f));
  return { dir: MAPLIBRE_PUBLIC_DIR, version, files: [...MAPLIBRE_RUNTIME_FILES] };
}

/**
 * Data the app ships in the repository itself (apps/desktop/assets): the reference layer
 * (Natural Earth borders and names, built by tools/dev/reference-data/build.mjs) and the
 * 2D label glyphs. Served next to index.html as `reference/…` and `fonts/…`.
 */
export const BUNDLED_ASSET_DIRS = ['reference', 'fonts'];
export const BUNDLED_ASSETS_SOURCE = path.join(appDir, 'assets');

export function stageBundledAssets() {
  const staged = [];
  for (const dir of BUNDLED_ASSET_DIRS) {
    const from = path.join(BUNDLED_ASSETS_SOURCE, dir);
    if (!existsSync(from)) throw new Error(`bundled assets missing: ${from}`);
    const to = path.join(VITE_PUBLIC_DIR, dir);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    staged.push(to);
  }
  return staged;
}

/** Every static asset the renderers load at run time. */
export function stageRendererAssets() {
  return { cesium: stageCesiumAssets(), maplibre: stageMapLibreAssets(), bundled: stageBundledAssets() };
}
