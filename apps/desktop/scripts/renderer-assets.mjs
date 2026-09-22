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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
 * MapLibre's stylesheet, staged rather than imported.
 *
 * `maplibre-gl` positions its canvas and its controls entirely from CSS —
 * `.maplibregl-map { position: relative }`, `.maplibregl-canvas { position: absolute }`,
 * and every control, popup and attribution rule. Nothing in this repository imported it,
 * so 2D had been running without it since the adapter was written. That is the same
 * defect Cesium had: a renderer whose layout lives in a stylesheet nobody loaded.
 *
 * It is staged and linked from index.html rather than imported through the bundler
 * because the workspace type-checks with `maplibre-gl` mapped to a declaration shim in
 * environments where the package is not installed, and a deep import of a .css file under
 * that mapping does not resolve. Staging keeps the file exactly as MapLibre ships it and
 * keeps the typecheck honest.
 */
export function stageMapLibreStylesheet() {
  const candidates = packageFileCandidates('maplibre-gl', path.join('dist', 'maplibre-gl.css'));
  const source = candidates.find((c) => existsSync(c));
  if (!source) {
    throw new Error(
      `maplibre-gl stylesheet not found (looked in ${candidates.join(', ')}); the 2D map would render unpositioned`,
    );
  }
  rmSync(MAPLIBRE_PUBLIC_DIR, { recursive: true, force: true });
  mkdirSync(MAPLIBRE_PUBLIC_DIR, { recursive: true });
  const dest = path.join(MAPLIBRE_PUBLIC_DIR, 'maplibre-gl.css');
  cpSync(source, dest);
  return dest;
}

/** Every static asset the renderers load at run time. */
export function stageRendererAssets() {
  return { cesium: stageCesiumAssets(), maplibre: stageMapLibreStylesheet() };
}
