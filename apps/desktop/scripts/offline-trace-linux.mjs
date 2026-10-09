#!/usr/bin/env node
/**
 * Does WorldView, told to work offline, try to reach anything but this computer? Linux only.
 *
 *   node apps/desktop/scripts/offline-trace-linux.mjs <executable> [--seconds 60] [--out file.json] [--control]
 *
 * `--control` leaves Work offline off: the same trace must then see the app reach out (DNS,
 * outside addresses), which is what shows a PASS above is the app's doing, not a blind trace.
 *
 * 1. Launch once with an isolated XDG_CONFIG_HOME until the renderer has mounted, then quit: the
 *    app writes a settings.json of its own current schema.
 * 2. Turn on Settings → Network → Work offline in that file.
 * 3. Launch again under `strace -f -e trace=connect` for `--seconds`, sandbox on, and read every
 *    connect() the whole process tree made.
 *
 * A connect() to a Unix socket (D-Bus, X) or to loopback (127.0.0.0/8, ::1) is this computer;
 * anything else is an attempt to leave it, and so is any connect() to port 53 — a DNS lookup,
 * even through a local resolver (systemd-resolved listens on 127.0.0.53), means something asked
 * for a name on the network. The result lists both, with the process and address.
 *
 * This measures the app, not the machine's network: it holds whether or not a network is up,
 * and it is the evidence for "WORLDVIEW attempts no WAN connections" (docs/cyberdeck, demo B).
 * Run it as an ordinary user with a display (xvfb-run -a in a terminal or CI).
 */
import { spawn, spawnSync } from 'node:child_process';
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
  console.error('usage: offline-trace-linux.mjs <executable> [--seconds 60] [--out file.json]');
  process.exit(2);
}
if (process.platform !== 'linux' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
  console.error('[offline-trace] run on Linux as an ordinary user (Chromium will not run as root sandboxed)');
  process.exit(2);
}
if (spawnSync('strace', ['-V']).status !== 0) {
  console.error('[offline-trace] needs strace (sudo apt install strace)');
  process.exit(2);
}
const seconds = Number(opt('--seconds') ?? 60);
const profile = mkdtempSync(path.join(tmpdir(), 'worldview-offline-trace-'));
const appData = path.join(profile, '@worldview', 'desktop');
const logFile = path.join(appData, 'logs', 'app.log');
const settingsFile = path.join(appData, 'settings.json');
const traceFile = path.join(profile, 'connect.trace');
const env = { ...process.env, XDG_CONFIG_HOME: profile };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logMessages() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

async function runUntil(command, argv, done, timeoutMs) {
  const child = spawn(command, argv, { env, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => (exited = true));
  const started = Date.now();
  while (!exited && Date.now() - started < timeoutMs && !done()) await sleep(500);
  if (!exited) {
    child.kill('SIGTERM');
    for (let i = 0; i < 20 && !exited; i++) await sleep(500);
    if (!exited) child.kill('SIGKILL');
  }
  await sleep(500);
}

// 1. A first launch writes the settings file.
await runUntil(executable, [], () => logMessages().some((r) => r.message === 'renderer media'), 120_000);
if (!existsSync(settingsFile)) {
  console.error(`[offline-trace] the first launch wrote no ${settingsFile}`);
  process.exit(1);
}

// 2. Work offline (unless this is the control run).
const control = args.includes('--control');
const doc = JSON.parse(readFileSync(settingsFile, 'utf8'));
doc.settings = { ...doc.settings, network: { workOffline: !control } };
writeFileSync(settingsFile, JSON.stringify(doc, null, 2) + '\n');
const before = logMessages().length;

// 3. Traced launch.
const startedAt = Date.now();
await runUntil(
  'strace',
  ['-f', '-qq', '-e', 'trace=connect', '-o', traceFile, executable],
  () => Date.now() - startedAt >= seconds * 1000,
  (seconds + 30) * 1000,
);

const lines = existsSync(traceFile) ? readFileSync(traceFile, 'utf8').split('\n') : [];
const unix = [];
const loopback = [];
const dns = [];
const outside = [];
for (const line of lines) {
  if (!line.includes('connect(')) continue;
  const pid = /^(\d+)/.exec(line)?.[1] ?? '?';
  if (/sa_family=AF_UNIX/.test(line)) {
    unix.push(line);
    continue;
  }
  const v4 = /sa_family=AF_INET,\s*sin_port=htons\((\d+)\),\s*sin_addr=inet_addr\("([^"]+)"\)/.exec(line);
  const v6 = /sa_family=AF_INET6,\s*sin6_port=htons\((\d+)\),.*?inet_pton\(AF_INET6,\s*"([^"]+)"/.exec(line);
  const m = v4 ?? v6;
  if (!m) continue; // AF_NETLINK and the like: not a connection anywhere
  const [, port, addr] = m;
  const entry = { pid, address: addr, port: Number(port) };
  const isLoopback = /^127\./.test(addr) || addr === '::1' || /^::ffff:127\./.test(addr);
  if (Number(port) === 53) dns.push(entry);
  else if (isLoopback) loopback.push(entry);
  else outside.push(entry);
}

const after = logMessages().slice(before);
const quiet = outside.length === 0 && dns.length === 0;
const mounted = after.some((r) => r.message === 'renderer media');
const result = {
  executable,
  // Control: the app must have tried to reach out, or the trace proves nothing.
  ok: mounted && (control ? !quiet : quiet),
  seconds,
  workOffline: !control,
  rendererMounted: after.some((r) => r.message === 'renderer media'),
  connects: { unix: unix.length, loopback: loopback.length, dnsLookups: dns.length, outside: outside.length },
  outside: outside.slice(0, 50),
  dnsLookups: dns.slice(0, 50),
  loopback: loopback.slice(0, 20),
  blockedByTheApp: after.filter((r) => r.message === 'working offline: request not sent').map((r) => r.fields?.host),
  traceLines: lines.length,
};
console.log(JSON.stringify(result, null, 2));
const out = opt('--out');
if (out) {
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
}
console.log(result.ok ? '[offline-trace] PASS' : '[offline-trace] FAIL');
process.exit(result.ok ? 0 : 1);
