import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { TypedEmitter, silentLogger, type Logger } from '@worldview/core';
import { writeFileAtomic } from '@worldview/core/node';
import type { VaultHealthSummary, VaultSetting } from '@worldview/ipc-contract';

/**
 * Data vaults — operator-granted folders outside the app's own, usually on an external SSD,
 * that hold world packs (docs/cyberdeck/ARCHITECTURE.md, M2).
 *
 * The one rule everything here serves: **never write through a missing drive.** When a USB
 * drive is not mounted, its mount point (`/media/<user>/<label>`, `D:\`) is either gone or an
 * empty folder on the internal disk. A path alone cannot tell the two apart, so a vault is
 * recognised by the marker file WorldView writes into it when the operator adds it
 * (`.worldview-vault.json`, a random id). No marker → `absent`, whatever the folder looks like;
 * another vault's marker → `foreign`. Nothing in this module creates the vault folder, and
 * nothing writes to a vault that did not just prove it is the right one.
 *
 * Nothing here deletes anything on a vault either.
 */

export const VAULT_MARKER_FILE = '.worldview-vault.json';
/** World packs inside a vault: `<vault>/worldpacks/<pack id>/`, the same layout as the app's own. */
export const VAULT_PACKS_DIR = 'worldpacks';
/** Below this much free space nothing new is written to a vault (it stays readable). */
export const DEFAULT_LOW_SPACE_BYTES = 2 * 1024 ** 3;
const PROBE_PREFIX = '.wv-probe-';
const MAX_MARKER_BYTES = 4096;
const ID_PATTERN = /^[0-9a-f]{32}$/;

export type VaultState = VaultHealthSummary['state'];

export interface VaultMarker {
  formatVersion: 1;
  app: 'worldview';
  id: string;
  label: string;
  createdAt: string;
}

export interface VaultHealth extends VaultHealthSummary {
  /** Device number of the folder (st_dev), to notice a remount; absent when not present. */
  device?: number;
}

/** Packs can be read from a vault in these states. */
export function vaultReadable(state: VaultState): boolean {
  return state === 'ready' || state === 'read-only' || state === 'low-space';
}

/** Something new (a pack) can be written to a vault only in this state. */
export function vaultWritable(state: VaultState): boolean {
  return state === 'ready';
}

/** Filesystem calls the probe uses, injectable so every failure can be tested. */
export interface VaultFs {
  stat(p: string): Promise<{ isDirectory(): boolean; dev: number }>;
  readFile(p: string): Promise<Buffer>;
  statfs(p: string): Promise<{ bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }>;
  /** Create a new file exclusively, write one byte, close it. */
  createExclusive(p: string): Promise<void>;
  unlink(p: string): Promise<void>;
}

export const nodeVaultFs: VaultFs = {
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p),
  statfs: (p) => fs.statfs(p),
  async createExclusive(p) {
    const handle = await fs.open(p, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile('x');
    } finally {
      await handle.close();
    }
  },
  unlink: (p) => fs.unlink(p),
};

export interface ProbeOptions {
  fs?: VaultFs;
  /** Try writing a file (and removing it). Off: writable is assumed from the last probe that did. */
  probeWrite?: boolean;
  lowSpaceBytes?: number;
  now?: () => number;
}

function code(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A marker parsed and checked, or why not. */
export function parseVaultMarker(bytes: Buffer): { ok: true; marker: VaultMarker } | { ok: false; reason: string } {
  if (bytes.length > MAX_MARKER_BYTES) return { ok: false, reason: 'marker file is too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'marker file is not JSON' };
  }
  const m = raw as Partial<VaultMarker>;
  if (!m || typeof m !== 'object' || m.formatVersion !== 1 || m.app !== 'worldview')
    return { ok: false, reason: 'marker file is not a WorldView vault marker' };
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return { ok: false, reason: 'marker id is malformed' };
  return {
    ok: true,
    marker: {
      formatVersion: 1,
      app: 'worldview',
      id: m.id,
      label: typeof m.label === 'string' ? m.label.slice(0, 80) : '',
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
    },
  };
}

/**
 * Check one vault. Reads only, except the optional write probe — which runs only after the
 * marker proved this is the right vault, creates a uniquely named file, and removes it.
 */
export async function probeVault(vault: VaultSetting, opts: ProbeOptions = {}): Promise<VaultHealth> {
  const vfs = opts.fs ?? nodeVaultFs;
  const now = opts.now ?? Date.now;
  const base = { id: vault.id, label: vault.label, path: vault.path };
  const result = (state: VaultState, msg: string, extra: Partial<VaultHealth> = {}): VaultHealth => ({
    ...base,
    state,
    message: msg,
    checkedAt: new Date(now()).toISOString(),
    ...extra,
  });

  let device: number;
  try {
    const st = await vfs.stat(vault.path);
    if (!st.isDirectory()) return result('absent', `${vault.path} is not a folder`);
    device = st.dev;
  } catch (err) {
    const c = code(err);
    if (c === 'ENOENT' || c === 'ENOTDIR')
      return result('absent', `"${vault.label}" is not connected (${vault.path} is not there)`);
    return result('error', `could not check ${vault.path}: ${message(err)}`);
  }

  let marker: VaultMarker;
  try {
    const parsed = parseVaultMarker(await vfs.readFile(path.join(vault.path, VAULT_MARKER_FILE)));
    if (!parsed.ok) return result('error', `${vault.path}: ${parsed.reason}`, { device });
    marker = parsed.marker;
  } catch (err) {
    if (code(err) === 'ENOENT')
      // The folder exists but is not the vault: the classic unmounted-drive mount point.
      return result(
        'absent',
        `"${vault.label}" is not connected: ${vault.path} is there but is not the vault (is the drive mounted?)`,
        { device },
      );
    return result('error', `could not read the vault marker in ${vault.path}: ${message(err)}`, { device });
  }
  if (marker.id !== vault.id)
    return result(
      'foreign',
      `${vault.path} holds a different WorldView vault${marker.label ? ` ("${marker.label}")` : ''}, not "${vault.label}"`,
      { device },
    );

  let freeBytes: number | undefined;
  let totalBytes: number | undefined;
  try {
    const s = await vfs.statfs(vault.path);
    freeBytes = Number(s.bavail) * Number(s.bsize);
    totalBytes = Number(s.blocks) * Number(s.bsize);
  } catch {
    // Not fatal: some filesystems do not answer statfs. Space is then unknown, not low.
  }
  const space = {
    device,
    ...(freeBytes !== undefined ? { freeBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
  };

  if (opts.probeWrite) {
    const probe = path.join(vault.path, `${PROBE_PREFIX}${randomBytes(6).toString('hex')}`);
    try {
      await vfs.createExclusive(probe);
      await vfs.unlink(probe).catch(() => undefined);
    } catch (err) {
      const c = code(err);
      if (c === 'EROFS' || c === 'EACCES' || c === 'EPERM')
        return result('read-only', `"${vault.label}" can be read but not written (${c})`, space);
      if (c === 'ENOSPC') return result('low-space', `"${vault.label}" is full`, space);
      return result('error', `could not write to ${vault.path}: ${message(err)}`, space);
    }
  }

  const low = opts.lowSpaceBytes ?? DEFAULT_LOW_SPACE_BYTES;
  if (freeBytes !== undefined && freeBytes < low)
    return result(
      'low-space',
      `"${vault.label}" has ${(freeBytes / 1024 ** 3).toFixed(1)} GB free; nothing new is written below ${(low / 1024 ** 3).toFixed(1)} GB`,
      space,
    );
  return result('ready', `"${vault.label}" is connected`, space);
}

/** Why a folder cannot become a vault, or undefined. Syntactic only; the folder is checked separately. */
export function vaultPathProblem(folder: string, appDataDir?: string): string | undefined {
  if (!path.isAbsolute(folder)) return 'the vault folder must be an absolute path';
  const resolved = path.resolve(folder);
  if (resolved === path.parse(resolved).root)
    return 'a whole drive root cannot be a vault; choose or make a folder on it';
  if (appDataDir) {
    const app = path.resolve(appDataDir);
    const rel = path.relative(app, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))
      return "the vault cannot be inside WorldView's own data folder";
    const back = path.relative(resolved, app);
    if (!back.startsWith('..') && !path.isAbsolute(back)) return "the vault cannot contain WorldView's own data folder";
  }
  return undefined;
}

/**
 * Make `folder` a vault, or adopt the vault already there. The folder must exist (the operator
 * chose it in a dialog); this never creates it, so choosing an unmounted drive's mount point
 * fails here rather than turning the internal disk into a "vault".
 */
export async function initVault(
  folder: string,
  label: string,
  opts: { appDataDir?: string; now?: () => number } = {},
): Promise<{ ok: true; vault: VaultSetting; adopted: boolean } | { ok: false; reason: string }> {
  const problem = vaultPathProblem(folder, opts.appDataDir);
  if (problem) return { ok: false, reason: problem };
  let real: string;
  try {
    real = await fs.realpath(folder);
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, reason: `${folder} is not a folder` };
  } catch (err) {
    return { ok: false, reason: `${folder} cannot be used: ${message(err)}` };
  }
  const realProblem = vaultPathProblem(real, opts.appDataDir);
  if (realProblem) return { ok: false, reason: realProblem };

  const markerFile = path.join(real, VAULT_MARKER_FILE);
  try {
    const parsed = parseVaultMarker(await fs.readFile(markerFile));
    if (!parsed.ok) return { ok: false, reason: `${real} has an unusable vault marker: ${parsed.reason}` };
    await fs.mkdir(path.join(real, VAULT_PACKS_DIR), { recursive: true });
    return {
      ok: true,
      adopted: true,
      vault: { id: parsed.marker.id, label: parsed.marker.label || cleanLabel(label, real), path: real },
    };
  } catch (err) {
    if (code(err) !== 'ENOENT') return { ok: false, reason: `could not read ${markerFile}: ${message(err)}` };
  }
  const marker: VaultMarker = {
    formatVersion: 1,
    app: 'worldview',
    id: randomBytes(16).toString('hex'),
    label: cleanLabel(label, real),
    createdAt: new Date((opts.now ?? Date.now)()).toISOString(),
  };
  try {
    await writeFileAtomic(markerFile, JSON.stringify(marker, null, 2) + '\n');
    await fs.mkdir(path.join(real, VAULT_PACKS_DIR), { recursive: true });
  } catch (err) {
    return { ok: false, reason: `${real} cannot be written: ${message(err)}` };
  }
  return { ok: true, adopted: false, vault: { id: marker.id, label: marker.label, path: real } };
}

function cleanLabel(label: string, folder: string): string {
  const l = [...label]
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('')
    .trim()
    .slice(0, 80);
  return l || path.basename(folder) || 'Vault';
}

export interface VaultMonitorEvents extends Record<string, unknown> {
  /** Some vault changed state (or the list of vaults changed). */
  changed: { vaults: VaultHealth[] };
}

export interface VaultMonitorOptions {
  vaults: () => VaultSetting[];
  intervalMs?: number;
  /** A write probe runs on a vault's first check, on any state change, and at least this often. */
  writeProbeEveryMs?: number;
  lowSpaceBytes?: number;
  fs?: VaultFs;
  logger?: Logger;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

/**
 * Re-checks every vault on a slow timer (30 s: a stat, a 200-byte read and a statfs per vault),
 * writes a probe file only now and then, and emits `changed` when a state changes — not on
 * every free-space wobble. A drive pulled while the app runs reads `absent` on the next tick;
 * plugged back in, `ready` again; packs on it follow (the runtime refreshes the registry).
 */
export class VaultMonitor {
  private readonly emitter = new TypedEmitter<VaultMonitorEvents>();
  private health = new Map<string, VaultHealth>();
  private lastWriteProbe = new Map<string, number>();
  private timer: { cancel(): void } | undefined;
  private running = false;
  private inFlight: Promise<VaultHealth[]> | undefined;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: VaultMonitorOptions) {
    this.log = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  on<K extends keyof VaultMonitorEvents>(event: K, listener: (p: VaultMonitorEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  /** The last result for every configured vault (in settings order). */
  current(): VaultHealth[] {
    return this.opts.vaults().flatMap((v) => {
      const h = this.health.get(v.id);
      return h ? [h] : [];
    });
  }

  get(id: string): VaultHealth | undefined {
    return this.health.get(id);
  }

  /** Check every vault now. Concurrent calls share one pass. */
  check(): Promise<VaultHealth[]> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      void this.check().finally(() => {
        if (this.running) this.timer = this.schedule(tick, this.opts.intervalMs ?? 30_000);
      });
    };
    tick();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private schedule(fn: () => void, ms: number): { cancel(): void } {
    if (this.opts.schedule) return this.opts.schedule(fn, ms);
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  }

  private async pass(): Promise<VaultHealth[]> {
    const vaults = this.opts.vaults();
    const known = new Set(vaults.map((v) => v.id));
    let changed = [...this.health.keys()].some((id) => !known.has(id));
    for (const id of [...this.health.keys()]) if (!known.has(id)) this.health.delete(id);
    for (const v of vaults) {
      const prev = this.health.get(v.id);
      const lastWrite = this.lastWriteProbe.get(v.id);
      const due =
        !prev || lastWrite === undefined || this.now() - lastWrite >= (this.opts.writeProbeEveryMs ?? 10 * 60_000);
      let next = await probeVault(v, this.probeOpts(due));
      // A state change seen without a write probe is confirmed with one before it is reported.
      if (!due && prev && next.state !== prev.state && vaultReadable(next.state))
        next = await probeVault(v, this.probeOpts(true));
      if (due || (prev && next.state !== prev.state)) this.lastWriteProbe.set(v.id, this.now());
      this.health.set(v.id, next);
      if (!prev || prev.state !== next.state || prev.path !== next.path) {
        changed = true;
        this.log.info('vault', { id: v.id, label: v.label, state: next.state, message: next.message });
      } else if (prev.device !== undefined && next.device !== undefined && prev.device !== next.device) {
        this.log.info('vault remounted', { id: v.id, label: v.label });
      }
    }
    const result = this.current();
    if (changed) this.emitter.emit('changed', { vaults: result });
    return result;
  }

  private probeOpts(probeWrite: boolean): ProbeOptions {
    return {
      probeWrite,
      ...(this.opts.fs ? { fs: this.opts.fs } : {}),
      ...(this.opts.lowSpaceBytes !== undefined ? { lowSpaceBytes: this.opts.lowSpaceBytes } : {}),
      now: this.now,
    };
  }
}

/** The public shape (no device number) for settings pages and diagnostics. */
export function vaultSummary(h: VaultHealth): VaultHealthSummary {
  const { device: _device, ...rest } = h;
  return rest;
}
