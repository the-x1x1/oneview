import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { systemClock, type Clock } from '@worldview/world-model';
import { TypedEmitter, silentLogger, type Logger } from '@worldview/core';
import { readJsonFile, writeFileAtomic } from '@worldview/core/node';
import type { ConnectionSnapshot } from '@worldview/source-health';
import type { OfflineStatus, WorldPackSignatureSummary, WorldPackSummary } from '@worldview/ipc-contract';
import {
  WORLDPACK_MANIFEST_PATH,
  WORLDPACK_SEARCH_INDEX_PATH,
  compareSemver,
  parseWorldPackManifest,
  type WorldPackManifest,
} from './manifest.js';
import { PlaceIndex } from './place-index.js';
import {
  MAX_SIGNATURE_BYTES,
  WORLDPACK_SIGNATURE_PATH,
  checkSignature,
  formatKeyId,
  keyIdOf,
  type PackSignature,
  type TrustedPublisher,
} from './signature.js';
import { errorText, extractWorldPack, type WorldPackVerification } from './verify.js';
import type { ZipReaderLimits } from './zip.js';

/**
 * WorldPackRegistry — installed packs under `<dataDir>/worldpacks/<id>/`.
 *
 *   install(file)  verify → extract to a staging directory → atomic rename into place
 *   list()         every pack directory with its validated manifest (invalid ones are
 *                  listed with a message, never silently dropped)
 *   capabilities() what the app can do locally right now
 *   placeIndex()   merged local search index of the enabled, valid packs
 *
 * State that is not in the pack itself (enabled flag, install time) lives in
 * `worldpacks/state.json`; a pack directory holds exactly the archive's files.
 *
 * Trust — the operator's publishers and whether only their packs are accepted — lives in
 * `worldpacks/trust.json`. A pack's signature is re-checked against its manifest on every
 * scan (a few hundred bytes of Ed25519, not the pack's files), so a manifest edited after
 * installation reads as tampered, and a publisher removed from the list stops counting.
 */
export type OfflineCapabilities = OfflineStatus['capabilities'];

export interface CapabilityFlags {
  history: boolean;
  collections: boolean;
  localAircraft: boolean;
}

export interface WorldPackRegistryOptions {
  dataDir: string;
  /** App version compared against manifest.minimumAppVersion. */
  appVersion: string;
  clock?: Clock;
  logger?: Logger;
  limits?: ZipReaderLimits;
  /** Capabilities that come from elsewhere (history store open, collections store, local receiver). */
  flags?: () => CapabilityFlags;
}

export interface InstalledWorldPack {
  summary: WorldPackSummary;
  manifest?: WorldPackManifest;
  /** Who signed the manifest (checked when the directory was scanned). */
  signature?: PackSignature;
  dir: string;
  enabled: boolean;
}

export interface TrustState {
  formatVersion: 1;
  /** Only packs signed by one of `publishers` are installed or used. */
  requireTrusted: boolean;
  publishers: TrustedPublisher[];
}

export interface WorldPackRegistryEvents extends Record<string, unknown> {
  changed: { packs: WorldPackSummary[]; capabilities: OfflineCapabilities };
}

interface PackState {
  installedAt: string;
  enabled: boolean;
  sourceFile?: string;
  sizeBytes: number;
}
interface RegistryState {
  formatVersion: 1;
  packs: Record<string, PackState>;
}

const STATE_FILE = 'state.json';
const TRUST_FILE = 'trust.json';
const MAX_PUBLISHERS = 64;
const STAGING_DIR = '.staging';
const MAX_INDEX_BYTES = 256 * 1024 * 1024;

export class WorldPackRegistry {
  readonly root: string;
  private readonly appVersion: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly limits: ZipReaderLimits | undefined;
  private readonly flags: () => CapabilityFlags;
  private readonly emitter = new TypedEmitter<WorldPackRegistryEvents>();
  private packs: InstalledWorldPack[] = [];
  private index = new PlaceIndex();
  private trust: TrustState = { formatVersion: 1, requireTrusted: false, publishers: [] };
  private loaded = false;

  constructor(opts: WorldPackRegistryOptions) {
    this.root = path.join(opts.dataDir, 'worldpacks');
    this.appVersion = opts.appVersion;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.logger ?? silentLogger;
    this.limits = opts.limits;
    this.flags = opts.flags ?? (() => ({ history: false, collections: false, localAircraft: false }));
  }

  on<K extends keyof WorldPackRegistryEvents>(
    event: K,
    listener: (payload: WorldPackRegistryEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Rescan the pack directory; call once at startup and after external changes. */
  async refresh(): Promise<InstalledWorldPack[]> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true }).catch(() => undefined);
    const state = await this.readState();
    this.trust = await this.readTrust();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const packs: InstalledWorldPack[] = [];
    const indexes: PlaceIndex[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(this.root, e.name);
      const st = state.packs[e.name];
      const enabled = st?.enabled ?? true;
      const installedAt = st?.installedAt ?? (await dirMtimeIso(dir));
      const pack = await this.loadPack(e.name, dir, enabled, installedAt);
      packs.push(pack);
      if (pack.summary.status === 'active' && pack.manifest?.contents.some((c) => c.kind === 'search-index')) {
        const ix = await this.loadIndex(dir);
        if (ix.ok) indexes.push(ix.index);
        else {
          pack.summary.status = 'invalid';
          pack.summary.message = `search index unreadable: ${ix.error}`;
        }
      }
    }
    this.packs = packs;
    this.index = PlaceIndex.merge(indexes);
    this.loaded = true;
    return packs;
  }

  list(): InstalledWorldPack[] {
    return this.packs.map((p) => ({ ...p, summary: { ...p.summary } }));
  }
  summaries(): WorldPackSummary[] {
    return this.packs.map((p) => ({ ...p.summary }));
  }
  get(id: string): InstalledWorldPack | undefined {
    return this.packs.find((p) => p.summary.id === id);
  }

  /** Enabled, valid packs. */
  active(): InstalledWorldPack[] {
    return this.packs.filter((p) => p.summary.status === 'active');
  }

  capabilities(): OfflineCapabilities {
    const flags = this.flags();
    const active = this.active();
    return {
      localMap: active.some((p) => p.manifest?.contents.some((c) => c.kind === 'pmtiles')),
      localSearch: this.index.size > 0,
      history: flags.history,
      collections: flags.collections,
      localAircraft: flags.localAircraft,
    };
  }

  status(connection: ConnectionSnapshot): OfflineStatus {
    return {
      connection,
      packs: this.summaries(),
      capabilities: this.capabilities(),
      trust: {
        requireTrusted: this.trust.requireTrusted,
        publishers: this.trust.publishers.map(({ keyId, name, addedAt }) => ({ keyId, name, addedAt })),
      },
    };
  }

  /** The operator's publishers and whether only their packs are accepted. */
  trustState(): TrustState {
    return { ...this.trust, publishers: this.trust.publishers.map((p) => ({ ...p })) };
  }

  /** Trust whoever signed an installed pack, under `name`. */
  async trustPackPublisher(packId: string, name: string): Promise<TrustedPublisher> {
    if (!this.loaded) await this.refresh();
    const sig = this.get(packId)?.signature;
    if (sig?.status === 'unchecked')
      throw new Error(`pack "${packId}"'s signature could not be checked here, so its key cannot be trusted from it`);
    if (sig?.status !== 'signed') throw new Error(`pack "${packId}" is not signed, so there is no publisher to trust`);
    return this.addPublisher(name, sig.publicKey);
  }

  /** Add (or rename) a publisher by public key — from a key file the publisher handed out. */
  async addPublisher(name: string, publicKey: string): Promise<TrustedPublisher> {
    const raw = Buffer.from(publicKey, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== publicKey) throw new Error('not a 32-byte Ed25519 public key');
    const keyId = keyIdOf(raw);
    const label = name.trim().slice(0, 80) || `Publisher ${formatKeyId(keyId)}`;
    const trust = await this.readTrust();
    const existing = trust.publishers.find((p) => p.publicKey === publicKey);
    let publisher: TrustedPublisher;
    if (existing) {
      existing.name = label;
      publisher = existing;
    } else {
      if (trust.publishers.length >= MAX_PUBLISHERS) throw new Error(`at most ${MAX_PUBLISHERS} publishers`);
      publisher = { keyId, publicKey, name: label, addedAt: new Date(this.clock.now()).toISOString() };
      trust.publishers.push(publisher);
    }
    await this.writeTrust(trust);
    this.log.info('worldpack publisher trusted', { keyId, name: label });
    await this.refresh();
    this.emitChanged();
    return { ...publisher };
  }

  async removePublisher(keyId: string): Promise<boolean> {
    const trust = await this.readTrust();
    const before = trust.publishers.length;
    trust.publishers = trust.publishers.filter((p) => p.keyId !== keyId);
    if (trust.publishers.length === before) return false;
    await this.writeTrust(trust);
    this.log.info('worldpack publisher removed', { keyId });
    await this.refresh();
    this.emitChanged();
    return true;
  }

  async setRequireTrusted(required: boolean): Promise<void> {
    const trust = await this.readTrust();
    trust.requireTrusted = required;
    await this.writeTrust(trust);
    this.log.info('worldpack trust policy', { requireTrusted: required });
    await this.refresh();
    this.emitChanged();
  }

  /** Absolute paths of the PMTiles archives in enabled, valid packs (newest pack first). */
  pmtilesPaths(): string[] {
    const out: Array<{ path: string; createdAt: string }> = [];
    for (const p of this.active())
      for (const c of p.manifest?.contents ?? [])
        if (c.kind === 'pmtiles')
          out.push({ path: path.join(p.dir, ...c.path.split('/')), createdAt: p.manifest!.createdAt });
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((x) => x.path);
  }

  /** Absolute paths of data files of a given kind (geojson/ndjson/parquet) in enabled, valid packs. */
  dataFiles(
    kind: 'geojson' | 'ndjson' | 'parquet',
    objectType?: string,
  ): Array<{ packId: string; path: string; objectType?: string; providerId?: string; rowCount?: number }> {
    const out: Array<{ packId: string; path: string; objectType?: string; providerId?: string; rowCount?: number }> =
      [];
    for (const p of this.active()) {
      for (const c of p.manifest?.contents ?? []) {
        if (c.kind !== kind) continue;
        if (objectType !== undefined && c.objectType !== objectType) continue;
        out.push({
          packId: p.summary.id,
          path: path.join(p.dir, ...c.path.split('/')),
          ...(c.objectType !== undefined ? { objectType: c.objectType } : {}),
          ...(c.providerId !== undefined ? { providerId: c.providerId } : {}),
          ...(c.rowCount !== undefined ? { rowCount: c.rowCount } : {}),
        });
      }
    }
    return out;
  }

  /** Merged PlaceIndex of the enabled, valid packs. */
  placeIndex(): PlaceIndex {
    return this.index;
  }

  /** Verify, extract to staging, then atomically activate. Replaces an existing pack with the same id. */
  async install(
    archivePath: string,
  ): Promise<{ installed: WorldPackSummary | null; issues: string[]; verification: WorldPackVerification }> {
    if (!this.loaded) await this.refresh();
    const stagingRoot = path.join(this.root, STAGING_DIR);
    await fs.mkdir(stagingRoot, { recursive: true });
    const staging = path.join(
      stagingRoot,
      `${path
        .basename(archivePath)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 40)}-${randomBytes(6).toString('hex')}`,
    );
    let verification: WorldPackVerification;
    try {
      verification = await extractWorldPack(archivePath, staging, {
        appVersion: this.appVersion,
        now: this.clock.now(),
        trustedPublishers: this.trust.publishers,
        requireTrusted: this.trust.requireTrusted,
        ...(this.limits ? { limits: this.limits } : {}),
      });
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const message = errorText(err);
      this.log.warn('worldpack install failed', { file: path.basename(archivePath), error: message });
      return {
        installed: null,
        issues: [message],
        verification: { ok: false, file: archivePath, sizeBytes: 0, entries: [], issues: [message], warnings: [] },
      };
    }
    if (!verification.ok || !verification.manifest) {
      this.log.warn('worldpack rejected', {
        file: path.basename(archivePath),
        issues: verification.issues.slice(0, 5),
      });
      return { installed: null, issues: verification.issues, verification };
    }
    const manifest = verification.manifest;
    const target = path.join(this.root, manifest.id);
    try {
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const message = `activation failed: ${errorText(err)}`;
      this.log.error('worldpack activation failed', { id: manifest.id, error: message });
      return { installed: null, issues: [message], verification: { ...verification, ok: false, issues: [message] } };
    }
    const state = await this.readState();
    state.packs[manifest.id] = {
      installedAt: new Date(this.clock.now()).toISOString(),
      enabled: state.packs[manifest.id]?.enabled ?? true,
      sourceFile: path.basename(archivePath),
      sizeBytes: verification.entries.reduce((n, e) => n + e.sizeBytes, 0),
    };
    await this.writeState(state);
    await this.refresh();
    this.log.info('worldpack installed', {
      id: manifest.id,
      name: manifest.name,
      entries: verification.entries.length,
      warnings: verification.warnings.length,
      signature: signatureSummary(verification.signature).status,
      ...(verification.signature && 'keyId' in verification.signature ? { keyId: verification.signature.keyId } : {}),
    });
    this.emitChanged();
    const installed = this.get(manifest.id)?.summary ?? null;
    return { installed, issues: verification.warnings, verification };
  }

  async remove(id: string): Promise<boolean> {
    if (!this.loaded) await this.refresh();
    const pack = this.get(id);
    if (!pack) return false;
    await fs.rm(pack.dir, { recursive: true, force: true });
    const state = await this.readState();
    delete state.packs[id];
    await this.writeState(state);
    await this.refresh();
    this.log.info('worldpack removed', { id });
    this.emitChanged();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (!this.loaded) await this.refresh();
    const pack = this.get(id);
    if (!pack) return false;
    const state = await this.readState();
    const prev = state.packs[id];
    state.packs[id] = {
      installedAt: prev?.installedAt ?? pack.summary.installedAt,
      enabled,
      sizeBytes: prev?.sizeBytes ?? pack.summary.sizeBytes,
      ...(prev?.sourceFile ? { sourceFile: prev.sourceFile } : {}),
    };
    await this.writeState(state);
    await this.refresh();
    this.emitChanged();
    return true;
  }

  /** Re-hash every file of an installed pack against its manifest (diagnostics; not run on every list). */
  async verifyInstalled(id: string): Promise<{ ok: boolean; issues: string[] }> {
    const pack = this.get(id);
    if (!pack?.manifest)
      return { ok: false, issues: [pack ? (pack.summary.message ?? 'invalid pack') : 'not installed'] };
    const issues: string[] = [];
    for (const c of pack.manifest.contents) {
      const file = path.join(pack.dir, ...c.path.split('/'));
      try {
        const sha = await sha256File(file);
        if (sha !== c.sha256) issues.push(`${c.path}: SHA-256 mismatch`);
      } catch (err) {
        issues.push(`${c.path}: ${errorText(err)}`);
      }
    }
    return { ok: issues.length === 0, issues };
  }

  private async loadPack(
    dirName: string,
    dir: string,
    enabled: boolean,
    installedAt: string,
  ): Promise<InstalledWorldPack> {
    const invalid = (message: string, manifest?: WorldPackManifest): InstalledWorldPack => ({
      summary: {
        // The directory name is the identity the registry acts on (remove/setEnabled), even when the manifest disagrees.
        id: dirName,
        name: manifest?.name ?? dirName,
        version: manifest ? versionOf(manifest) : '',
        installedAt,
        sizeBytes: 0,
        bounds: manifest?.geographicBounds ?? { west: 0, south: 0, east: 0, north: 0 },
        contents: manifest?.contents.map((c) => c.path) ?? [],
        status: 'invalid',
        message,
      },
      ...(manifest ? { manifest } : {}),
      dir,
      enabled,
    });
    let manifestBytes: Buffer;
    try {
      manifestBytes = await fs.readFile(path.join(dir, WORLDPACK_MANIFEST_PATH));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return invalid('manifest.json missing');
      return invalid(`manifest unreadable: ${errorText(err)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(manifestBytes.toString('utf8'));
    } catch (err) {
      return invalid(`manifest unreadable: ${errorText(err)}`);
    }
    const parsed = parseWorldPackManifest(raw);
    if (!parsed.ok) return invalid(`manifest invalid: ${parsed.issues.slice(0, 3).join('; ')}`);
    const manifest = parsed.manifest;
    if (manifest.id !== dirName)
      return invalid(`directory "${dirName}" does not match manifest id "${manifest.id}"`, manifest);
    if (compareSemver(this.appVersion, manifest.minimumAppVersion) < 0)
      return invalid(`requires app version >= ${manifest.minimumAppVersion}`, manifest);
    const signature = checkSignature(manifestBytes, await readSignatureFile(dir), this.trust.publishers);
    if (signature.status === 'invalid') {
      const broken = invalid(`signature: ${signature.reason}`, manifest);
      return { ...broken, signature, summary: { ...broken.summary, signature: signatureSummary(signature) } };
    }
    let sizeBytes = 0;
    for (const c of manifest.contents) {
      const file = path.join(dir, ...c.path.split('/'));
      try {
        const st = await fs.stat(file);
        if (!st.isFile()) return invalid(`${c.path} is not a file`, manifest);
        if (st.size !== c.sizeBytes)
          return invalid(`${c.path}: size ${st.size} differs from manifest ${c.sizeBytes}`, manifest);
        sizeBytes += st.size;
      } catch (err) {
        return invalid(`${c.path}: ${errorText(err)}`, manifest);
      }
    }
    const summary: WorldPackSummary = {
      id: manifest.id,
      name: manifest.name,
      version: versionOf(manifest),
      installedAt,
      sizeBytes,
      bounds: manifest.geographicBounds,
      contents: manifest.contents.map((c) => c.path),
      status: enabled ? 'active' : 'disabled',
      signature: signatureSummary(signature),
    };
    if (manifest.expiresAt !== undefined && this.clock.now() > Date.parse(manifest.expiresAt))
      summary.message = `expired on ${manifest.expiresAt.slice(0, 10)}`;
    if (this.trust.requireTrusted && !(signature.status === 'signed' && signature.trusted)) {
      summary.status = 'invalid';
      summary.message = 'not signed by one of your trusted publishers, which this app now requires';
    }
    return { summary, manifest, signature, dir, enabled };
  }

  private async loadIndex(dir: string): Promise<{ ok: true; index: PlaceIndex } | { ok: false; error: string }> {
    const file = path.join(dir, ...WORLDPACK_SEARCH_INDEX_PATH.split('/'));
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_INDEX_BYTES) return { ok: false, error: `index larger than ${MAX_INDEX_BYTES} bytes` };
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      const r = PlaceIndex.fromJSON(raw);
      return r.ok ? r : { ok: false, error: r.issues.join('; ') };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  private async readState(): Promise<RegistryState> {
    const raw = await readJsonFile<Partial<RegistryState>>(path.join(this.root, STATE_FILE)).catch(() => undefined);
    const packs: Record<string, PackState> = {};
    if (raw && typeof raw === 'object' && raw.packs && typeof raw.packs === 'object') {
      for (const [id, v] of Object.entries(raw.packs)) {
        if (!v || typeof v !== 'object') continue;
        const p = v as Partial<PackState>;
        packs[id] = {
          installedAt: typeof p.installedAt === 'string' ? p.installedAt : new Date(this.clock.now()).toISOString(),
          enabled: p.enabled !== false,
          sizeBytes: typeof p.sizeBytes === 'number' ? p.sizeBytes : 0,
          ...(typeof p.sourceFile === 'string' ? { sourceFile: p.sourceFile } : {}),
        };
      }
    }
    return { formatVersion: 1, packs };
  }

  private async writeState(state: RegistryState): Promise<void> {
    await writeFileAtomic(path.join(this.root, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
  }

  /** trust.json, read defensively: a malformed entry is dropped, never half-trusted. */
  private async readTrust(): Promise<TrustState> {
    const raw = await readJsonFile<Partial<TrustState>>(path.join(this.root, TRUST_FILE)).catch(() => undefined);
    const publishers: TrustedPublisher[] = [];
    for (const p of Array.isArray(raw?.publishers) ? raw.publishers : []) {
      if (!p || typeof p !== 'object' || typeof p.publicKey !== 'string' || typeof p.name !== 'string') continue;
      const key = Buffer.from(p.publicKey, 'base64');
      if (key.length !== 32 || key.toString('base64') !== p.publicKey) continue;
      publishers.push({
        keyId: keyIdOf(key),
        publicKey: p.publicKey,
        name: p.name.slice(0, 80),
        addedAt: typeof p.addedAt === 'string' ? p.addedAt : new Date(0).toISOString(),
      });
    }
    return { formatVersion: 1, requireTrusted: raw?.requireTrusted === true, publishers };
  }

  private async writeTrust(trust: TrustState): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await writeFileAtomic(path.join(this.root, TRUST_FILE), JSON.stringify(trust, null, 2) + '\n');
    this.trust = trust;
  }

  private emitChanged(): void {
    this.emitter.emit('changed', { packs: this.summaries(), capabilities: this.capabilities() });
  }
}

/** What the page is told about a signature: never the public key itself. */
export function signatureSummary(sig: PackSignature | undefined): WorldPackSignatureSummary {
  switch (sig?.status) {
    case undefined:
    case 'unsigned':
      return { status: 'unsigned' };
    case 'invalid':
      return { status: 'invalid', reason: sig.reason };
    case 'unchecked':
      return { status: 'unchecked', keyId: sig.keyId, reason: sig.reason };
    case 'signed':
      return sig.trusted
        ? { status: 'trusted', keyId: sig.keyId, ...(sig.publisher ? { publisher: sig.publisher } : {}) }
        : { status: 'signed', keyId: sig.keyId };
  }
}

async function readSignatureFile(dir: string): Promise<Buffer | undefined> {
  const file = path.join(dir, WORLDPACK_SIGNATURE_PATH);
  try {
    const st = await fs.stat(file);
    // Oversized: a stand-in one byte over the limit fails the check with the size as its reason.
    if (st.size > MAX_SIGNATURE_BYTES) return Buffer.alloc(MAX_SIGNATURE_BYTES + 1);
    return await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // There, but unreadable: fails the check rather than passing for unsigned.
    return Buffer.from('unreadable');
  }
}

function versionOf(m: WorldPackManifest): string {
  return m.version ?? m.createdAt.slice(0, 10);
}

async function dirMtimeIso(dir: string): Promise<string> {
  try {
    return (await fs.stat(dir)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
