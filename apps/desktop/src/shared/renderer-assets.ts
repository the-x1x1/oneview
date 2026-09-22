/**
 * Paths, relative to index.html, of renderer files that are staged rather than bundled.
 *
 * The build stages them from `scripts/renderer-assets.mjs`, which runs under plain Node and
 * cannot be imported by the renderer (it reaches for `node:fs`). So the path is spelled in
 * both places and `renderer-assets.test.ts` fails if they drift — a renderer asking for one
 * path while the build stages another is precisely how the MapLibre worker went missing.
 */
export const MAPLIBRE_WORKER_PATH = 'maplibre/maplibre-gl-worker.mjs';
