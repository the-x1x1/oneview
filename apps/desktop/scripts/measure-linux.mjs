#!/usr/bin/env node
/**
 * Performance and power observations on Linux (docs/cyberdeck M5, hardware check H12): start
 * WorldView, time it, let it sit, and read what it costs — from /proc and /sys only, while it
 * runs as a user would run it (sandbox on, no extra flags).
 *
 *   node apps/desktop/scripts/measure-linux.mjs <executable> [options]
 *
 *     --profile field|balanced|docked   the profile to measure (default balanced)
 *     --runs <n>                        launches to measure (default 3)
 *     --idle <seconds>                  how long each launch sits untouched (default 300)
 *     --settle <seconds>                wait after the window appears before measuring (default 30)
 *     --baseline                        measure the computer with WorldView NOT running, for the
 *                                       same idle time: the system power draw to compare with
 *     --label <text>                    what you want to remember about this run (e.g. "on battery, lid open")
 *     --out <file.json>                 write the result here as well
 *
 * What it reports, per launch: time from the spawn until the runtime started and until the page
 * had loaded (from the app's own log); whether the shell mounted (confirmed a fixed 4 s later by
 * the app's watchdog, so not a time); resident memory of each process type
 * (main, renderer, GPU, utility) sampled every 5 s, as mean and peak — RSS, and PSS, whose total
 * is the honest "memory the app holds" (RSS totals count shared Chromium pages repeatedly); CPU used over the idle
 * period, in % of one core, per process type; GPU busy % where the driver exposes it (amdgpu:
 * gpu_busy_percent); and the WHOLE COMPUTER's power draw from the battery (power_now, or the
 * energy_now drop) when it runs on battery. That last one is not WorldView's own use: compare a
 * run with `--baseline` under the same conditions (brightness, radios, other programs) to see
 * what WorldView adds. Conditions are recorded with the numbers; nothing is estimated.
 *
 * An isolated XDG_CONFIG_HOME is used (a first, unmeasured launch creates it and the profile is
 * set in its settings), so the real profile is neither read nor changed. With no data sources
 * configured that is the app at its quietest — say so if you compare with daily use.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);
const baseline = flag('--baseline');
const executable = baseline ? undefined : args[0];
if (process.platform !== 'linux') {
  console.error('[measure] Linux only: it reads /proc and /sys');
  process.exit(2);
}
if (!baseline && (!executable || executable.startsWith('--') || !existsSync(executable))) {
  console.error(
    'usage: measure-linux.mjs <executable> [--profile p] [--runs n] [--idle s] [--settle s] [--label t] [--out f]',
  );
  console.error('       measure-linux.mjs --baseline [--idle s] [--label t] [--out f]');
  process.exit(2);
}
if (!baseline && typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('[measure] run as an ordinary user: Chromium will not run as root with its sandbox on');
  process.exit(2);
}
const profileName = opt('--profile', 'balanced');
if (!['field', 'balanced', 'docked'].includes(profileName)) {
  console.error(`[measure] unknown profile ${profileName}`);
  process.exit(2);
}
const runs = Math.max(1, Number(opt('--runs', 3)));
const idleS = Math.max(10, Number(opt('--idle', 300)));
const settleS = Math.max(0, Number(opt('--settle', 30)));
const label = opt('--label', '');
const outFile = opt('--out');
const SAMPLE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clkTck = (() => {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  } catch {
    return 100;
  }
})();
const pageKb = (() => {
  try {
    return (Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) || 4096) / 1024;
  } catch {
    return 4;
  }
})();

const read = (file) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
};
const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

// ---- conditions ----------------------------------------------------------------------------

function batteries() {
  const dir = '/sys/class/power_supply';
  const out = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const d = path.join(dir, name);
    if (read(path.join(d, 'type')) !== 'Battery' || read(path.join(d, 'scope')) === 'Device') continue;
    out.push({
      name,
      status: read(path.join(d, 'status')),
      capacity: num(read(path.join(d, 'capacity'))),
      // µW and µWh (or µA / µAh with voltage_now in µV).
      powerNow: num(read(path.join(d, 'power_now'))),
      energyNow: num(read(path.join(d, 'energy_now'))),
      currentNow: num(read(path.join(d, 'current_now'))),
      chargeNow: num(read(path.join(d, 'charge_now'))),
      voltageNow: num(read(path.join(d, 'voltage_now'))),
    });
  }
  return out;
}

/** Whole-computer draw from the batteries, in watts; undefined on mains or when not reported. */
function systemWatts() {
  let w = 0;
  let seen = false;
  for (const b of batteries()) {
    if (b.status !== 'Discharging') continue;
    if (b.powerNow !== undefined) {
      w += b.powerNow / 1e6;
      seen = true;
    } else if (b.currentNow !== undefined && b.voltageNow !== undefined) {
      w += (b.currentNow / 1e6) * (b.voltageNow / 1e6);
      seen = true;
    }
  }
  return seen ? w : undefined;
}

/** Stored energy across batteries in Wh (energy_now, or charge_now × voltage). */
function storedWh() {
  let wh = 0;
  let seen = false;
  for (const b of batteries()) {
    if (b.energyNow !== undefined) {
      wh += b.energyNow / 1e6;
      seen = true;
    } else if (b.chargeNow !== undefined && b.voltageNow !== undefined) {
      wh += (b.chargeNow / 1e6) * (b.voltageNow / 1e6);
      seen = true;
    }
  }
  return seen ? wh : undefined;
}

function gpuBusy() {
  const dir = '/sys/class/drm';
  const out = {};
  for (const card of existsSync(dir) ? readdirSync(dir).filter((c) => /^card\d+$/.test(c)) : []) {
    const v = num(read(path.join(dir, card, 'device', 'gpu_busy_percent')));
    if (v !== undefined) out[card] = v;
  }
  return out;
}

function conditions() {
  const cpu = (read('/proc/cpuinfo') ?? '').match(/^model name\s*:\s*(.+)$/m)?.[1];
  const backlight = (() => {
    const dir = '/sys/class/backlight';
    for (const b of existsSync(dir) ? readdirSync(dir) : []) {
      const cur = num(read(path.join(dir, b, 'brightness')));
      const max = num(read(path.join(dir, b, 'max_brightness')));
      if (cur !== undefined && max) return `${Math.round((cur / max) * 100)}%`;
    }
    return undefined;
  })();
  const ac = (() => {
    const dir = '/sys/class/power_supply';
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const type = read(path.join(dir, name, 'type'));
      if (type === 'Mains' || type?.startsWith('USB')) if (read(path.join(dir, name, 'online')) === '1') return true;
    }
    return false;
  })();
  return {
    at: new Date().toISOString(),
    label,
    kernel: read('/proc/sys/kernel/osrelease'),
    os: (read('/etc/os-release') ?? '').match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1],
    cpu,
    cpus: (read('/proc/cpuinfo') ?? '').match(/^processor\s*:/gm)?.length,
    memTotalMB: Math.round((num((read('/proc/meminfo') ?? '').match(/^MemTotal:\s+(\d+)/m)?.[1]) ?? 0) / 1024),
    session:
      process.env.XDG_SESSION_TYPE ??
      (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : undefined),
    desktop: process.env.XDG_CURRENT_DESKTOP,
    onMains: ac,
    batteries: batteries().map((b) => ({ name: b.name, status: b.status, capacity: b.capacity })),
    backlight,
    load: read('/proc/loadavg'),
  };
}

// ---- processes -------------------------------------------------------------------------------

/**
 * The launched app's processes: the one this script started and everything descended from it
 * (Chromium's zygote, renderers, GPU and utility processes) — never another WorldView that
 * happens to be running from the same install.
 */
function descendants(rootPid) {
  const children = new Map();
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    const ppid = num(read(`/proc/${pid}/status`)?.match(/^PPid:\s+(\d+)/m)?.[1]);
    if (ppid === undefined) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(pid));
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

function appProcesses(rootPid) {
  const found = [];
  for (const pid of descendants(rootPid)) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .flatMap((a) => a.split(' '))
        .filter(Boolean);
      const type = argv.find((a) => a.startsWith('--type='))?.slice(7) ?? 'main';
      const statm = readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // utime and stime are fields 14 and 15; after the command they are the 12th and 13th.
      const ticks = Number(fields[11]) + Number(fields[12]);
      // PSS shares each shared page out between the processes using it: the sum is what the app
      // as a whole holds (RSS summed counts the shared Chromium pages once per process).
      const pssKb = num(read(`/proc/${pid}/smaps_rollup`)?.match(/^Pss:\s+(\d+)/m)?.[1]);
      found.push({
        pid: Number(pid),
        type,
        rssMB: (Number(statm[1]) * pageKb) / 1024,
        pssMB: pssKb !== undefined ? pssKb / 1024 : undefined,
        ticks,
      });
    } catch {
      // gone, or not ours
    }
  }
  return found;
}

const byType = (procs, key) => {
  const out = {};
  for (const p of procs) out[p.type] = (out[p.type] ?? 0) + p[key];
  return out;
};
const round = (v, d = 1) => (v === undefined ? undefined : Math.round(v * 10 ** d) / 10 ** d);
const stats = (xs) =>
  xs.length ? { mean: round(xs.reduce((a, b) => a + b, 0) / xs.length), peak: round(Math.max(...xs)) } : undefined;

// ---- one measured period ---------------------------------------------------------------------

async function idlePeriod(appPid) {
  const rss = {};
  const pss = {};
  const watts = [];
  const gpu = {};
  const startProcs = appPid ? appProcesses(appPid) : [];
  const startTicks = new Map(startProcs.map((p) => [p.pid, p]));
  const whStart = storedWh();
  const started = Date.now();
  while (Date.now() - started < idleS * 1000) {
    await sleep(SAMPLE_MS);
    if (appPid) {
      const now = appProcesses(appPid);
      if (now.length === 0) throw new Error('the app has no processes left to measure (it exited?)');
      for (const [type, mb] of Object.entries(byType(now, 'rssMB'))) (rss[type] ??= []).push(mb);
      (rss.total ??= []).push(now.reduce((a, p) => a + p.rssMB, 0));
      if (now.every((p) => p.pssMB !== undefined)) {
        for (const [type, mb] of Object.entries(byType(now, 'pssMB'))) (pss[type] ??= []).push(mb);
        (pss.total ??= []).push(now.reduce((a, p) => a + p.pssMB, 0));
      }
    }
    const w = systemWatts();
    if (w !== undefined) watts.push(w);
    for (const [card, v] of Object.entries(gpuBusy())) (gpu[card] ??= []).push(v);
  }
  const seconds = (Date.now() - started) / 1000;
  const cpu = {};
  if (appPid) {
    for (const p of appProcesses(appPid)) {
      const before = startTicks.get(p.pid);
      const used = (p.ticks - (before?.ticks ?? 0)) / clkTck;
      cpu[p.type] = (cpu[p.type] ?? 0) + used;
    }
    cpu.total = Object.values(cpu).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(cpu)) cpu[k] = round((cpu[k] / seconds) * 100, 2);
  }
  const whEnd = storedWh();
  return {
    seconds: round(seconds, 0),
    ...(appPid ? { rssMB: Object.fromEntries(Object.entries(rss).map(([k, v]) => [k, stats(v)])) } : {}),
    ...(appPid && Object.keys(pss).length
      ? { pssMB: Object.fromEntries(Object.entries(pss).map(([k, v]) => [k, stats(v)])) }
      : {}),
    ...(appPid ? { cpuPctOfOneCore: cpu } : {}),
    gpuBusyPct: Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, stats(v)])),
    systemWatts: stats(watts),
    ...(whStart !== undefined && whEnd !== undefined && whEnd < whStart
      ? { systemWattsFromEnergy: round(((whStart - whEnd) * 3600) / seconds, 2) }
      : {}),
  };
}

// ---- launches --------------------------------------------------------------------------------

function records(logFile) {
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

async function launchMeasured(xdg, logFile, measure) {
  const before = records(logFile).length;
  const t0 = Date.now();
  const child = spawn(executable, [], { env: { ...process.env, XDG_CONFIG_HOME: xdg }, stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));
  let startedAt;
  let loadedAt;
  let mountedAt;
  let drewNothing = false;
  while (Date.now() - t0 < 120_000 && !exited && !mountedAt && !drewNothing) {
    await sleep(100);
    const mine = records(logFile).slice(before);
    const at = (m) => {
      const r = mine.find((x) => x.message === m);
      return r ? Date.parse(r.time ?? r.ts ?? r.at) : undefined;
    };
    startedAt ??= at('runtime started');
    loadedAt ??= at('renderer loaded');
    // "renderer media" follows the watchdog's check that the shell mounted, which runs a fixed
    // 4 s after the page loaded: proof of a mounted window, not a time to compare.
    mountedAt = at('renderer media');
    drewNothing = at('renderer drew nothing') !== undefined;
  }
  let result = {
    exited,
    // From spawning the executable, by the app's own log clock.
    runtimeStartedMs: startedAt ? startedAt - t0 : undefined,
    pageLoadedMs: loadedAt ? loadedAt - t0 : undefined,
    mounted: mountedAt !== undefined,
  };
  if (mountedAt && measure) {
    await sleep(settleS * 1000);
    try {
      result = { ...result, idle: await idlePeriod(child.pid) };
    } catch (err) {
      result = { ...result, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (!exited) {
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && !exited; i++) await sleep(250);
    if (!exited) child.kill('SIGKILL');
  }
  await sleep(1000);
  return result;
}

const result = { tool: 'measure-linux', conditions: conditions(), clkTck };
if (baseline) {
  console.log(`[measure] baseline: ${idleS} s with WorldView not running`);
  result.baseline = await idlePeriod(undefined);
} else {
  const xdg = mkdtempSync(path.join(tmpdir(), 'worldview-measure-'));
  const logFile = path.join(xdg, '@worldview', 'desktop', 'logs', 'app.log');
  const settingsFile = path.join(xdg, '@worldview', 'desktop', 'settings.json');
  console.log('[measure] first launch (not measured): creates the profile');
  const warm = await launchMeasured(xdg, logFile, false);
  if (!warm.mounted) {
    console.error('[measure] the first launch did not mount its window; see', logFile);
    process.exit(1);
  }
  // The profile, as the settings dialog would set it (store/actions.ts setProfile).
  const file = JSON.parse(readFileSync(settingsFile, 'utf8'));
  // settings.json is an envelope: { schemaVersion, settings: { … } }.
  const settings = file.settings && typeof file.settings === 'object' ? file.settings : file;
  const graphics = { field: 'low', balanced: 'auto', docked: 'high' }[profileName];
  settings.display = {
    ...settings.display,
    profile: profileName,
    graphics,
    ...(profileName === 'field' ? { fieldStatus: true } : {}),
  };
  if (profileName === 'field') settings.renderMode = '2D';
  if (profileName === 'docked') settings.renderMode = '3D';
  writeFileSync(settingsFile, JSON.stringify(file, null, 2));
  result.profile = profileName;
  result.runs = [];
  for (let i = 1; i <= runs; i++) {
    console.log(`[measure] run ${i}/${runs}: launch, wait ${settleS} s, sit ${idleS} s`);
    const before = records(logFile).length;
    const run = await launchMeasured(xdg, logFile, true);
    // What the runtime said it applied at start (profile name, internet poll scale), and what
    // the settings held afterwards (graphics, map mode): the profile as it was in effect.
    const applied = records(logFile)
      .slice(before)
      .find((r) => r.message === 'profile applied');
    const after = JSON.parse(readFileSync(settingsFile, 'utf8'));
    const held = after.settings ?? after;
    result.runs.push({
      ...run,
      profileApplied: applied?.fields ?? null,
      settingsHeld: { profile: held.display?.profile, graphics: held.display?.graphics, renderMode: held.renderMode },
    });
  }
  result.conditionsAfter = conditions();
}
const text = JSON.stringify(result, null, 2);
console.log(text);
if (outFile) writeFileSync(outFile, `${text}\n`);
