#!/usr/bin/env node
/**
 * `pnpm dev` — the Vite dev server, the watching main/preload build, and Electron.
 *
 * The script this replaced was:
 *
 *     node scripts/build-main.mjs --watch & vite --config vite.config.ts
 *
 * which did neither of the two things it needed to. `&` backgrounds a command in POSIX
 * shells, but pnpm runs scripts through cmd.exe on Windows, where `A & B` means "run A,
 * then run B" — and `--watch` never returns, so Vite never started. And nothing in the
 * repository launched Electron at all, in this script or anywhere else, though
 * docs/DEVELOPMENT.md has always described `pnpm dev` as "Electron + Vite dev server".
 * There was no way to open WORLDVIEW.
 *
 * Vite is driven through its Node API rather than its CLI: the API reports the address it
 * actually bound, which lets this script *check* that address against the one the main
 * process trusts instead of hoping they agree.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appDir } from './renderer-assets.mjs';

const require = createRequire(import.meta.url);

/**
 * The origin lives in src/shared/app-origin.ts, where the CSP and the navigation
 * allowlist read it. Parsing it here keeps one source of truth: a duplicated port is
 * exactly the drift this script exists to catch.
 */
function trustedDevOrigin() {
  const source = readFileSync(path.join(appDir, 'src', 'shared', 'app-origin.ts'), 'utf8');
  const match = /DEV_SERVER_ORIGIN\s*=\s*['"]([^'"]+)['"]/.exec(source);
  if (!match) throw new Error('could not read DEV_SERVER_ORIGIN from src/shared/app-origin.ts');
  return match[1];
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

// --- main + preload, rebuilt on change -------------------------------------
const watcher = spawn(process.execPath, [path.join(appDir, 'scripts', 'build-main.mjs'), '--watch'], {
  cwd: appDir,
  stdio: 'inherit',
});
children.push(watcher);
watcher.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[dev] the main/preload watcher exited (${code})`);
    shutdown(code ?? 1);
  }
});

// --- renderer --------------------------------------------------------------
const { createServer } = await import('vite');
const server = await createServer({ configFile: path.join(appDir, 'vite.config.ts') });
await server.listen();

const bound = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
const trusted = trustedDevOrigin();
if (!bound) {
  console.error('[dev] the Vite dev server reported no local URL');
  await server.close();
  shutdown(1);
}
if (bound !== trusted) {
  console.error(`[dev] the dev server is on ${bound} but the main process only trusts ${trusted}.`);
  console.error(
    '[dev] Electron would load a blank window. Reconcile vite.config.ts `server` with src/shared/app-origin.ts.',
  );
  await server.close();
  shutdown(1);
}
console.log(`[dev] renderer on ${bound}`);

// --- Electron --------------------------------------------------------------
// Resolved from node_modules: the `electron` package exports the path to its binary, and
// the .bin shim is not reliably spawnable on Windows (the same trap that made `pnpm
// typecheck` exit 1 in silence).
const electronPath = require('electron');
const electron = spawn(electronPath, ['.'], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, WORLDVIEW_DEV: '1' },
});
children.push(electron);
electron.on('exit', async (code) => {
  await server.close().catch(() => undefined);
  shutdown(code ?? 0);
});
