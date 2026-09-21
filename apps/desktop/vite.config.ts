import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * Renderer build (apps/desktop/src/renderer → dist/renderer). Everything the
 * renderer needs is bundled from the app origin so the production CSP can stay
 * `script-src 'self'` (see src/main/csp.ts). Cesium's static assets (Workers,
 * Assets, ThirdParty, Widgets) are copied into dist/renderer/cesium by
 * scripts/build-main.mjs (`--cesium-assets`) and referenced through CESIUM_BASE_URL.
 *
 * `dev:browser` serves the same renderer without Electron: the shell then uses the
 * in-process DemoClient (packages/ui) because `window.worldview` is absent.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');

function workspaceAliases(): Record<string, string> {
  const base = JSON.parse(readFileSync(path.join(workspaceRoot, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } };
  const out: Record<string, string> = {};
  for (const [name, targets] of Object.entries(base.compilerOptions.paths)) {
    const target = targets[0];
    if (target) out[name] = path.resolve(workspaceRoot, target);
  }
  return out;
}

export default defineConfig(({ mode }) => ({
  root: path.join(here, 'src', 'renderer'),
  base: './',
  publicDir: false,
  plugins: [react()],
  resolve: { alias: workspaceAliases() },
  define: {
    CESIUM_BASE_URL: JSON.stringify('./cesium'),
    __WORLDVIEW_DEMO__: JSON.stringify(process.env.WORLDVIEW_DEMO === '1' || mode === 'demo'),
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    fs: { strict: true, allow: [workspaceRoot], deny: ['**/.env', '**/.env.*', '**/credentials.json', '**/settings.json'] },
    headers: { 'X-Content-Type-Options': 'nosniff' },
  },
  build: {
    outDir: path.join(here, 'dist', 'renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome130',
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: { cesium: ['cesium'], maplibre: ['maplibre-gl'] } } },
  },
  worker: { format: 'es' },
}));
