import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { VITE_PUBLIC_DIR } from './scripts/cesium-assets.mjs';

/**
 * Renderer build (apps/desktop/src/renderer → dist/renderer). Everything the
 * renderer needs is bundled from the app origin so the production CSP can stay
 * `script-src 'self'` (see src/main/csp.ts). Cesium's static assets (Workers,
 * Assets, ThirdParty, Widgets) are staged into .vite-public/cesium by
 * scripts/cesium-assets.mjs and reach dist/renderer through Vite's publicDir, which is
 * copied *after* `emptyOutDir` wipes the directory. Writing them into dist/renderer
 * directly did not survive the build. They are referenced through CESIUM_BASE_URL.
 *
 * `dev:browser` serves the same renderer without Electron: the shell then uses the
 * in-process DemoClient (packages/ui) because `window.worldview` is absent.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');

/**
 * Workspace packages resolve through the same tsconfig paths the typecheck uses, but a
 * Vite alias is a prefix replacement while a tsconfig path maps a bare specifier to a
 * single file. Mapping `@worldview/ui` to `packages/ui/src/index.ts` therefore turned
 * `@worldview/ui/base.css` into `packages/ui/src/index.ts/base.css`, and the build
 * failed on a stylesheet that exists. Each package needs two rules: an exact match for
 * the bare specifier, and a directory rule for everything underneath it.
 */
function workspaceAliases(): Array<{ find: string | RegExp; replacement: string }> {
  const base = JSON.parse(readFileSync(path.join(workspaceRoot, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } };
  const out: Array<{ find: string | RegExp; replacement: string }> = [];
  for (const [name, targets] of Object.entries(base.compilerOptions.paths)) {
    const target = targets[0];
    if (!target) continue;
    const entry = path.resolve(workspaceRoot, target);
    // Subpaths first: Vite matches in order, and the bare rule would otherwise win.
    out.push({ find: `${name}/`, replacement: `${path.dirname(entry)}${path.sep}` });
    out.push({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: entry });
  }
  return out;
}

export default defineConfig(({ mode }) => ({
  root: path.join(here, 'src', 'renderer'),
  base: './',
  publicDir: VITE_PUBLIC_DIR,
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
