#!/usr/bin/env node
/**
 * Packaged-app smoke test for Linux: launch an installed or unpacked WorldView, read what it
 * says about itself in its own log, quit it, launch it again, and check what survived.
 *
 *   node apps/desktop/scripts/smoke-linux.mjs <executable> [options]
 *
 *     --expect-history duckdb-parquet|ndjson   the history backend the runtime must report
 *     --expect-keyring usable|refused          whether API keys can be stored (Secret Service)
 *     --timeout <seconds>                      per launch (default 90)
 *     --out <file.json>                        write the result here as well
 *
 * It needs a display (xvfb-run in CI) and runs the app with its sandbox on, exactly as a user
 * would: an isolated XDG_CONFIG_HOME so nothing of the real profile is read or written, and no
 * flags the packaged app would not get from its menu entry.
 *
 * What it proves, and what it does not: that the packaged main process starts, the renderer
 * mounts (renderer-watchdog.ts's probe found children under #root), the native DuckDB
 * binding loaded (or not — said plainly), the keyring state, and that settings written by the
 * first run are read by the second without migrating again. It does not prove the map draws:
 * a virtual display has no GPU, Chromium blocks WebGL there, and the map shows its "renderer
 * could not start" panel. That is recorded as `webgl` in the result, never as a pass.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const executable = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!executable || executable.startsWith('--') || !existsSync(executable)) {
  console.error(
    'usage: smoke-linux.mjs <executable> [--expect-history …] [--expect-keyring …] [--timeout s] [--out f]',
  );
  process.exit(2);
}
if (process.platform !== 'linux') {
  console.error('[smoke] this is the Linux packaged-app smoke test; run it on Linux');
  process.exit(2);
}
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  // Chromium refuses to run as root with its sandbox on, and the only way round that is
  // --no-sandbox, which this test exists to prove is never needed.
  console.error('[smoke] run as an ordinary user: Chromium will not run as root with its sandbox on');
  process.exit(2);
}
const timeoutMs = Number(opt('--timeout') ?? 90) * 1000;
const expectHistory = opt('--expect-history');
const expectKeyring = opt('--expect-keyring');

const profile = mkdtempSync(path.join(tmpdir(), 'worldview-smoke-'));
const logFile = path.join(profile, '@worldview', 'desktop', 'logs', 'app.log');
const settingsFile = path.join(profile, '@worldview', 'desktop', 'settings.json');

/** The JSON-lines records of app.log (core/node.ts RotatingFileSink). */
function records() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch once; resolve with the records this launch wrote once the renderer has mounted. */
async function launch(label) {
  const before = records().length;
  const child = spawn(executable, [], {
    env: { ...process.env, XDG_CONFIG_HOME: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  let exited = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));

  const started = Date.now();
  let mine = [];
  let mounted = false;
  while (Date.now() - started < timeoutMs && !exited) {
    await sleep(500);
    mine = records().slice(before);
    if (mine.some((r) => r.message === 'renderer drew nothing')) break;
    // "renderer media" is logged only after the watchdog found children under #root.
    mounted = mine.some((r) => r.message === 'runtime started') && mine.some((r) => r.message === 'renderer media');
    if (mounted) break;
  }
  const elapsedMs = Date.now() - started;
  if (!exited) {
    child.kill('SIGTERM');
    for (let i = 0; i < 20 && !exited; i++) await sleep(500);
    if (!exited) child.kill('SIGKILL');
  }
  await sleep(500);
  mine = records().slice(before);
  return { label, mounted, elapsedMs, exitedEarly: exited !== null && !mounted, exited, output, records: mine };
}

const field = (rs, message, key) => rs.find((r) => r.message === message)?.fields?.[key];

const problems = [];
const first = await launch('first launch');
const second = first.mounted ? await launch('second launch (same profile)') : undefined;

if (!first.mounted)
  problems.push(
    first.exitedEarly
      ? `first launch exited before the renderer mounted (${JSON.stringify(first.exited)}); output:\n${first.output.slice(-2000)}`
      : `first launch: the renderer did not mount within ${timeoutMs / 1000}s`,
  );

const historyBackend = field(first.records, 'runtime started', 'historyBackend');
const historyFallback = first.records.find((r) => /DuckDB backend unavailable/.test(r.message))?.fields?.reason;
if (expectHistory && historyBackend !== expectHistory)
  problems.push(
    `history backend is ${historyBackend ?? '(not reported)'}, expected ${expectHistory}${historyFallback ? ` — ${historyFallback}` : ''}`,
  );

const keyringBackend = field(first.records, 'secure storage', 'backend');
const keyringUsable = field(first.records, 'secure storage', 'usable');
if (expectKeyring && typeof keyringUsable !== 'boolean')
  problems.push(
    'the app logged no "secure storage" line, so the keyring state is unknown (a build from before the Linux work?)',
  );
else if (expectKeyring === 'usable' && keyringUsable !== true)
  problems.push(`API keys cannot be stored (backend ${keyringBackend ?? '(not reported)'}), expected a usable keyring`);
else if (expectKeyring === 'refused' && keyringUsable !== false)
  problems.push(`API keys can be stored (backend ${keyringBackend}), expected them to be refused with no keyring`);

for (const run of [first, second].filter(Boolean)) {
  for (const r of run.records) {
    if (
      ['uncaught exception', 'unhandled rejection', 'render process gone', 'renderer drew nothing'].includes(r.message)
    )
      problems.push(`${run.label}: ${r.message} ${JSON.stringify(r.fields ?? {}).slice(0, 400)}`);
  }
}

if (second) {
  if (!second.mounted) problems.push('second launch: the renderer did not mount');
  if (second.records.some((r) => r.message === 'migration applied'))
    problems.push('second launch migrated settings again: what the first launch wrote was not read back');
  if (!existsSync(settingsFile)) problems.push(`no settings file at ${settingsFile}`);
}

const webgl = first.records.some((r) =>
  /WebGL2? is required|WebGL.*not supported|no hardware 3D graphics/i.test(r.fields?.message ?? ''),
)
  ? 'unavailable (expected on a virtual display: the map shows its error panel)'
  : 'no WebGL error logged';

const result = {
  executable,
  ok: problems.length === 0,
  problems,
  firstLaunchMs: first.elapsedMs,
  secondLaunchMs: second?.elapsedMs,
  userData: path.dirname(path.dirname(logFile)),
  historyBackend: historyBackend ?? null,
  historyFallback: historyFallback ?? null,
  keyring: { backend: keyringBackend ?? null, usable: keyringUsable ?? null },
  providers: field(first.records, 'runtime started', 'providers') ?? null,
  settingsPersisted: Boolean(second?.mounted && !second.records.some((r) => r.message === 'migration applied')),
  webgl,
  sandbox: 'on (no --no-sandbox was passed)',
};

console.log(JSON.stringify(result, null, 2));
const out = opt('--out');
if (out) {
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
}
if (!result.ok) {
  console.error(`[smoke] FAIL (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
} else console.log('[smoke] PASS');
process.exit(result.ok ? 0 : 1);
