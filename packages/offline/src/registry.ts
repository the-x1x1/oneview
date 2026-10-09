import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs';
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
import { PlaceIndex, serializedPlaceIndexSchema, type PlaceEntry, type PlaceSearcher } from './place-index.js';
import { CompositePlaceSearch, SqlitePlaceIndex, loadSqlite, type SqliteModule } from './place-sqlite.js';
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
import {
  VAULT_PACKS_DIR,
  vaultMarkerMatches,
  vaultPacksDir,
  vaultReadable,
  vaultWritable,
  type VaultState,
} from './vault.js';
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
 *
 * Data vaults (vault.ts; docs/cyberdeck): packs can also live in `<vault>/worldpacks/<id>/` on an
 * operator-granted folder, usually an external SSD. They are read from every vault that is
 * readable, installed into one only while it is writable (staging on the vault itself, so the
 * final rename is atomic there), and never deleted by the registry (only its own staging from an
 * interrupted install is cleared). A vault's listing is believed only after its marker is read
 * again in the same scan, and its packs' state is forgotten only after a listing that worked.
 * Their state (enabled, when installed, which vault) lives in this app's own state.json, so a pulled drive's packs are
 * still listed — `invalid`, "not connected" — and come back as they were when it returns.
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
  /**
   * Where pack place indexes are searched: `auto` (the default) builds each into SQLite
   * when this runtime has `node:sqlite`, else keeps them in memory; `memory` always does.
   */
  placeIndexBackend?: 'auto' | 'memory';
  /** Data vaults packs are also read from, with their current health (vault.ts). Read on every refresh. */
  vaults?: () => RegistryVault[];
}

/** A data vault as the registry sees it: its root folder and what the last health check said. */
export interface RegistryVault {
  id: string;
  label: string;
  root: string;
  state: VaultState;
}

/** Install a pack into a vault rather than the app's own folder. */
export interface VaultInstallTarget {
  vault: RegistryVault;
  /**
   * Re-checks the vault immediately before anything is written and again before the pack is
   * activated: its device when it is still the right drive and writable, or why not (pulled
   * mid-install, remounted read-only, full). Every file extracted must be on that device.
   */
  recheck: () => Promise<{ ok: true; device: number } | { ok: false; reason: string }>;
}

/** Thrown for things the registry refuses to do to a pack on a vault (deleting it). */
export class VaultPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPackError';
  }
}

export interface InstalledWorldPack {
  summary: WorldPackSummary;
  manifest?: WorldPackManifest;
  /** Who signed the manifest (checked when the directory was scanned). */
  signature?: PackSignature;
  dir: string;
  enabled: boolean;
  /** The vault it lives on; absent for packs in the app's own folder. */
  vault?: { id: string; label: string };
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
  /** Set for a pack on a vault: where it is, and what to list while that vault is not connected. */
  vault?: PackVaultState;
}
interface PackVaultState {
  id: string;
  label: string;
  name: string;
  version: string;
  bounds: WorldPackSummary['bounds'];
}
interface RegistryState {
  formatVersion: 1;
  packs: Record<string, PackState>;
}

const STATE_FILE = 'state.json';
const TRUST_FILE = 'trust.json';
const MAX_PUBLISHERS = 64;
const STAGING_DIR = '.staging';
/** Place indexes built by the app from its packs (SQLite), one file per pack. */
const INDEX_DIR = '.index';
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
  private index: PlaceSearcher = new PlaceIndex();
  private sqliteIndexes: SqlitePlaceIndex[] = [];
  private sqlite: SqliteModule | null | undefined;
  private readonly placeIndexBackend: 'auto' | 'memory';
  private readonly vaultsOf: () => RegistryVault[];
  private trust: TrustState = { formatVersion: 1, requireTrusted: false, publishers: [] };
  private loaded = false;

  constructor(opts: WorldPackRegistryOptions) {
    this.root = path.join(opts.dataDir, 'worldpacks');
    this.appVersion = opts.appVersion;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.logger ?? silentLogger;
    this.limits = opts.limits;
    this.flags = opts.flags ?? (() => ({ history: false, collections: false, localAircraft: false }));
    this.placeIndexBackend = opts.placeIndexBackend ?? 'auto';
    this.vaultsOf = opts.vaults ?? (() => []);
  }

  /** Which store answers place search: 'sqlite' or 'memory' (diagnostics, logs, tests). */
  get placeIndexKind(): 'sqlite' | 'memory' {
    return this.sqliteIndexes.length > 0 ? 'sqlite' : 'memory';
  }

  on<K extends keyof WorldPackRegistryEvents>(
    event: K,
    listener: (payload: WorldPackRegistryEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /**
   * Rescan the pack directory (and the readable vaults); call once at startup and after external
   * changes. Calls are serialised: a vault plugged in while the operator installs a pack starts
   * two refreshes, and two scans writing state.json at once would interleave.
   */
  refresh(): Promise<InstalledWorldPack[]> {
    const run = this.refreshQueue.then(() => this.scan());
    this.refreshQueue = run.catch(() => undefined);
    return run;
  }

  private refreshQueue: Promise<unknown> = Promise.resolve();

  private async scan(): Promise<InstalledWorldPack[]> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true }).catch(() => undefined);
    const state = await this.readState();
    this.trust = await this.readTrust();
    const vaults = this.vaultsOf();
    const sources: Array<{ root: string; vault?: RegistryVault }> = [{ root: this.root }];
    // Why a configured vault is not read in this scan (absent, a stale "ready" over an empty
    // mount point, a symlinked packs folder …): its packs are listed as not usable, never forgotten.
    const notRead = new Map<string, string>();
    for (const v of vaults) {
      if (!vaultReadable(v.state)) {
        notRead.set(v.id, v.state === 'absent' ? 'not connected' : `not usable (${v.state})`);
        continue;
      }
      // The health check can be 30 s old: the marker is read again before the folder is believed.
      if (!(await vaultMarkerMatches(v.root, v.id))) {
        notRead.set(v.id, 'not connected');
        continue;
      }
      const dir = await vaultPacksDir(v.root);
      if (!dir.ok) {
        this.log.warn('vault packs refused', { vault: v.label, reason: dir.reason });
        notRead.set(v.id, `not usable: ${dir.reason}`);
        continue;
      }
      sources.push({ root: dir.dir, vault: v });
    }
    const packs: InstalledWorldPack[] = [];
    const indexes: PlaceIndex[] = [];
    // SQLite indexes hold no handle between searches (a Windows file that is open cannot be
    // replaced or deleted); `close` is kept for any index that ever does.
    for (const ix of this.sqliteIndexes) ix.close();
    this.sqliteIndexes = [];
    const sqlite = await this.sqliteModule();
    const sqliteIndexes: SqlitePlaceIndex[] = [];
    const startedAt = this.clock.now();
    let built = 0;
    const seen = new Map<string, string>();
    let stateChanged = false;
    for (const source of sources) {
      // A vault is only ever read here: a missing worldpacks folder is an empty vault, not one to create.
      const entries = await fs.readdir(source.root, { withFileTypes: true }).catch((err: unknown) => {
        if (!source.vault) throw err;
        // No worldpacks folder on a vault whose marker matched: an empty vault. Anything else
        // means its packs could not be read — listed as such, not forgotten.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log.warn('vault packs unreadable', { vault: source.vault.label, error: errorText(err) });
          notRead.set(source.vault.id, `not readable (${(err as NodeJS.ErrnoException).code ?? errorText(err)})`);
          return null;
        }
        return [];
      });
      if (entries === null) continue;
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const dir = path.join(source.root, e.name);
        const where = source.vault ? `the vault "${source.vault.label}"` : 'this computer';
        const first = seen.get(e.name);
        if (first !== undefined) {
          // The same pack in two places: the first is used, the other listed under its own id.
          packs.push({
            summary: {
              id: `${e.name}:${source.vault?.id ?? 'local'}`,
              name: e.name,
              version: '',
              installedAt: await dirMtimeIso(dir),
              sizeBytes: 0,
              bounds: { west: 0, south: 0, east: 0, north: 0 },
              contents: [],
              status: 'invalid',
              message: `also on ${where}; the copy on ${first} is used`,
              ...(source.vault ? { vault: { id: source.vault.id, label: source.vault.label } } : {}),
            },
            dir,
            enabled: false,
            ...(source.vault ? { vault: { id: source.vault.id, label: source.vault.label } } : {}),
          });
          continue;
        }
        seen.set(e.name, where);
        const st = state.packs[e.name];
        const enabled = st?.enabled ?? true;
        const installedAt = st?.installedAt ?? (await dirMtimeIso(dir));
        const loaded = await this.loadPack(e.name, dir, enabled, installedAt);
        const pack: InstalledWorldPack = source.vault
          ? {
              ...loaded,
              vault: { id: source.vault.id, label: source.vault.label },
              summary: { ...loaded.summary, vault: { id: source.vault.id, label: source.vault.label } },
            }
          : loaded;
        packs.push(pack);
        if (source.vault) {
          const remembered: PackVaultState = {
            id: source.vault.id,
            label: source.vault.label,
            name: pack.summary.name,
            version: pack.summary.version,
            bounds: pack.summary.bounds,
          };
          if (JSON.stringify(st?.vault) !== JSON.stringify(remembered)) {
            state.packs[e.name] = {
              installedAt,
              enabled,
              sizeBytes: st?.sizeBytes ?? pack.summary.sizeBytes,
              ...(st?.sourceFile ? { sourceFile: st.sourceFile } : {}),
              vault: remembered,
            };
            stateChanged = true;
          }
        } else if (st?.vault) {
          // It was on a vault and is now in the app's own folder.
          const { vault: _moved, ...rest } = st;
          state.packs[e.name] = rest;
          stateChanged = true;
        }
        if (pack.summary.status === 'active' && pack.manifest?.contents.some((c) => c.kind === 'search-index')) {
          const sha = pack.manifest.contents.find((c) => c.kind === 'search-index')!.sha256;
          if (sqlite) {
            try {
              const r = await SqlitePlaceIndex.openOrBuild(sqlite, this.sqliteIndexFile(e.name), sha, async () => {
                const ix = await this.loadEntries(dir);
                if (!ix.ok) throw new Error(ix.error);
                return ix.entries;
              });
              sqliteIndexes.push(r.index);
              if (r.built) built++;
            } catch (err) {
              pack.summary.status = 'invalid';
              pack.summary.message = `search index unreadable: ${errorText(err)}`;
            }
          } else {
            const ix = await this.loadIndex(dir);
            if (ix.ok) indexes.push(ix.index);
            else {
              pack.summary.status = 'invalid';
              pack.summary.message = `search index unreadable: ${ix.error}`;
            }
          }
        }
      }
    }
    // Packs on vaults that are not readable now: listed, not forgotten. Vaults no longer
    // configured at all are forgotten (their files are untouched).
    const configured = new Map(vaults.map((v) => [v.id, v]));
    for (const [id, st] of Object.entries(state.packs)) {
      if (!st.vault || seen.has(id)) continue;
      const v = configured.get(st.vault.id);
      if (!v) {
        delete state.packs[id];
        stateChanged = true;
        continue;
      }
      const why = notRead.get(v.id);
      if (why === undefined) {
        // Its vault was read just now, marker and all, and the pack is not on it: removed from the drive.
        delete state.packs[id];
        stateChanged = true;
        continue;
      }
      packs.push({
        summary: {
          id,
          name: st.vault.name,
          version: st.vault.version,
          installedAt: st.installedAt,
          sizeBytes: st.sizeBytes,
          bounds: st.vault.bounds,
          contents: [],
          status: 'invalid',
          message: `on the vault "${v.label}", which is ${why}`,
          vault: { id: v.id, label: v.label },
        },
        dir: path.join(v.root, VAULT_PACKS_DIR, id),
        enabled: st.enabled,
        vault: { id: v.id, label: v.label },
      });
    }
    if (stateChanged) await this.writeState(state);
    this.packs = packs;
    this.sqliteIndexes = sqliteIndexes;
    this.index = sqlite ? new CompositePlaceSearch(sqliteIndexes) : PlaceIndex.merge(indexes);
    if (sqlite) {
      // Indexes of packs on a vault that is away are kept for when it comes back.
      await this.dropStaleIndexes(new Set([...packs.map((p) => p.summary.id), ...Object.keys(state.packs)]));
      if (sqliteIndexes.length)
        this.log.info('place index', {
          backend: 'sqlite',
          packs: sqliteIndexes.length,
          entries: this.index.size,
          built,
          ms: this.clock.now() - startedAt,
        });
    }
    this.loaded = true;
    return packs;
  }

  private async sqliteModule(): Promise<SqliteModule | undefined> {
    if (this.placeIndexBackend === 'memory') return undefined;
    if (this.sqlite === undefined) {
      this.sqlite = (await loadSqlite()) ?? null;
      if (!this.sqlite) this.log.info('place index', { backend: 'memory', reason: 'node:sqlite is not available' });
    }
    return this.sqlite ?? undefined;
  }

  private sqliteIndexFile(packId: string): string {
    return path.join(this.root, INDEX_DIR, `${packId}.sqlite`);
  }

  /** Index files of packs no longer installed. */
  private async dropStaleIndexes(installed: ReadonlySet<string>): Promise<void> {
    const dir = path.join(this.root, INDEX_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const id = n.endsWith('.sqlite') ? n.slice(0, -'.sqlite'.length) : undefined;
      if (id !== undefined && installed.has(id)) continue;
      await fs.rm(path.join(dir, n), { force: true }).catch(() => undefined);
    }
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

  /**
   * The credit the newest PMTiles basemap's source asks for (the pack's source policy for the
   * provider that built it: "Protomaps · © OpenStreetMap contributors (ODbL)"), so the map
   * credits what it draws rather than a catalogue default.
   */
  pmtilesAttribution(): string | undefined {
    const newest = [...this.active()].sort((a, b) =>
      (b.manifest?.createdAt ?? '').localeCompare(a.manifest?.createdAt ?? ''),
    );
    for (const p of newest) {
      const map = p.manifest?.contents.find((c) => c.kind === 'pmtiles');
      if (!map) continue;
      const policy = p.manifest?.sourcePolicies.find((s) => s.providerId === map.providerId);
      return policy?.attribution;
    }
    return undefined;
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

  /**
   * Connector definition sets in enabled, valid packs (`definitions/*.json`). `trusted` only
   * when the pack's signature verifies with a key among the operator's publishers: the
   * runtime loads a set's definitions only then, as user-configured, and lists the rest as
   * refused. The directory is the extracted pack's own, checked when the pack was installed
   * and re-checked against the signed manifest on every scan.
   */
  definitionSets(): Array<{ packId: string; packName: string; dir: string; trusted: boolean; publisher?: string }> {
    const out: Array<{ packId: string; packName: string; dir: string; trusted: boolean; publisher?: string }> = [];
    for (const p of this.active()) {
      if (!p.manifest?.contents.some((c) => c.kind === 'definitions')) continue;
      const sig = p.signature;
      const trusted = sig?.status === 'signed' && sig.trusted;
      out.push({
        packId: p.summary.id,
        packName: p.manifest.name,
        dir: path.join(p.dir, 'definitions'),
        trusted,
        ...(sig?.status === 'signed' && sig.trusted && sig.publisher ? { publisher: sig.publisher } : {}),
      });
    }
    return out;
  }

  /** Merged PlaceIndex of the enabled, valid packs. */
  placeIndex(): PlaceSearcher {
    return this.index;
  }

  /**
   * Run `fn` in the refresh queue: install, remove and setEnabled read and write state.json, and
   * so does a scan; one at a time, or a scan that started first writes back a stale copy.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.refreshQueue.then(fn);
    this.refreshQueue = run.catch(() => undefined);
    return run;
  }

  /** Verify, extract to staging, then atomically activate. Replaces an existing pack with the same id. */
  install(
    archivePath: string,
    target?: VaultInstallTarget,
  ): Promise<{ installed: WorldPackSummary | null; issues: string[]; verification: WorldPackVerification }> {
    return this.exclusive(() => this.installNow(archivePath, target));
  }

  private async installNow(
    archivePath: string,
    target?: VaultInstallTarget,
  ): Promise<{ installed: WorldPackSummary | null; issues: string[]; verification: WorldPackVerification }> {
    // What is installed now, not at the last scan: a placeholder for a pack on a drive that has
    // since come back must not be "replaced" without the version and signer checks.
    await this.scan();
    const notInstalled = (message: string) => ({
      installed: null,
      issues: [message],
      verification: { ok: false, file: archivePath, sizeBytes: 0, entries: [], issues: [message], warnings: [] },
    });
    // Into a vault: only while it proves, right now, that it is the right drive and writable.
    // Staging sits on the vault itself, so activation is a rename on the same filesystem.
    const packsRoot = target ? path.join(target.vault.root, VAULT_PACKS_DIR) : this.root;
    const stagingRoot = path.join(packsRoot, STAGING_DIR);
    let device: number | undefined;
    if (target) {
      if (!vaultWritable(target.vault.state))
        return notInstalled(`the vault "${target.vault.label}" cannot be written to (${target.vault.state})`);
      const checked = await target.recheck();
      if (!checked.ok) return notInstalled(checked.reason);
      device = checked.device;
      const prepared = await prepareVaultStaging(target.vault.root, stagingRoot, device);
      if (prepared) return notInstalled(prepared);
    } else await fs.mkdir(stagingRoot, { recursive: true });
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
        ...(device !== undefined ? { device } : {}),
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
    const targetDir = path.join(packsRoot, manifest.id);
    const refuse = async (message: string) => {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      this.log.warn('worldpack rejected', { file: path.basename(archivePath), issues: [message] });
      return { installed: null, issues: [message], verification: { ...verification, ok: false, issues: [message] } };
    };
    // Replacing an installed pack: never an older one, never a different signer's — and only
    // where it already is (a pack is in one place; moving it is the operator's job).
    const installed = this.get(manifest.id);
    if (installed && installed.vault && !installed.manifest)
      return refuse(
        `"${manifest.id}" on the vault "${installed.vault.label}" cannot be read (${installed.summary.message ?? 'invalid'}); fix or remove it there first`,
      );
    if (installed && path.resolve(installed.dir) !== path.resolve(targetDir))
      return refuse(
        `"${manifest.id}" is already installed ${installed.vault ? `on the vault "${installed.vault.label}"` : 'on this computer'}; remove it there first, or install the update there`,
      );
    const replacing = installed?.manifest;
    const replaceProblem = replacing
      ? replacementProblem(replacing, installed!.signature, manifest, verification.signature)
      : undefined;
    if (replaceProblem) return refuse(replaceProblem);
    const notes = [...verification.warnings];
    if (manifest.base) {
      const assembled = await this.assembleUpdate(manifest, installed, staging);
      if (typeof assembled === 'string') return refuse(assembled);
      notes.unshift(
        `updated from the pack created ${replacing!.createdAt.slice(0, 10)}: ${assembled} of ${manifest.contents.length} files kept`,
      );
    } else if (replacing) notes.unshift(`replaced the pack created ${replacing.createdAt.slice(0, 10)}`);
    if (target) {
      const checked = await target.recheck();
      if (!checked.ok) return refuse(`not activated: ${checked.reason}`);
      if (checked.device !== device) return refuse('not activated: the drive changed during the install');
    }
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(staging, targetDir);
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
      ...(target
        ? {
            vault: {
              id: target.vault.id,
              label: target.vault.label,
              name: manifest.name,
              version: versionOf(manifest),
              bounds: manifest.geographicBounds,
            },
          }
        : {}),
    };
    await this.writeState(state);
    // Inside the queue already: a refresh() here would wait for itself.
    await this.scan();
    this.log.info('worldpack installed', {
      id: manifest.id,
      name: manifest.name,
      entries: verification.entries.length,
      warnings: verification.warnings.length,
      signature: signatureSummary(verification.signature).status,
      ...(verification.signature && 'keyId' in verification.signature ? { keyId: verification.signature.keyId } : {}),
    });
    this.emitChanged();
    return { installed: this.get(manifest.id)?.summary ?? null, issues: notes, verification };
  }

  /**
   * An update pack's files that come from the installed base: copied from it into staging and
   * checked against the update's SHA-256 before anything is replaced. Returns how many were
   * kept, or why the update cannot apply.
   */
  private async assembleUpdate(
    manifest: WorldPackManifest,
    installed: InstalledWorldPack | undefined,
    staging: string,
  ): Promise<number | string> {
    const base = manifest.base!;
    const wanted = `this is an update for the "${manifest.id}" pack created ${base.createdAt.slice(0, 10)}`;
    if (!installed?.manifest) return `${wanted}, which is not installed — install the full pack instead`;
    let installedBytes: Buffer;
    try {
      installedBytes = await fs.readFile(path.join(installed.dir, WORLDPACK_MANIFEST_PATH));
    } catch (err) {
      return `${wanted}; the installed one is unreadable (${errorText(err)})`;
    }
    if (createHash('sha256').update(installedBytes).digest('hex') !== base.manifestSha256)
      return `${wanted}; the installed one was created ${installed.manifest.createdAt.slice(0, 10)} — install the full pack instead`;
    let kept = 0;
    for (const c of manifest.contents) {
      if (!c.fromBase) continue;
      const from = path.join(installed.dir, ...c.path.split('/'));
      const to = path.join(staging, ...c.path.split('/'));
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
        const st = await fs.stat(to);
        if (st.size !== c.sizeBytes || (await sha256File(to)) !== c.sha256)
          return `${c.path}: the installed copy does not match the update (changed on disk?) — install the full pack instead`;
      } catch (err) {
        return `${c.path}: not taken from the installed pack (${errorText(err)})`;
      }
      kept++;
    }
    return kept;
  }

  remove(id: string): Promise<boolean> {
    return this.exclusive(() => this.removeNow(id));
  }

  private async removeNow(id: string): Promise<boolean> {
    if (!this.loaded) await this.scan();
    const pack = this.get(id);
    if (!pack) return false;
    if (pack.vault)
      throw new VaultPackError(
        `"${pack.summary.name}" is on the vault "${pack.vault.label}". WorldView does not delete files on a vault: switch the pack off here, or delete ${pack.dir} yourself.`,
      );
    await fs.rm(pack.dir, { recursive: true, force: true });
    const state = await this.readState();
    delete state.packs[id];
    await this.writeState(state);
    await this.scan();
    this.log.info('worldpack removed', { id });
    this.emitChanged();
    return true;
  }

  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.exclusive(() => this.setEnabledNow(id, enabled));
  }

  private async setEnabledNow(id: string, enabled: boolean): Promise<boolean> {
    if (!this.loaded) await this.scan();
    const pack = this.get(id);
    // A duplicate listed under `<id>:<vault>` is not a pack of its own: nothing to switch.
    if (!pack || pack.summary.id !== path.basename(pack.dir)) return false;
    const state = await this.readState();
    const prev = state.packs[id];
    state.packs[id] = {
      installedAt: prev?.installedAt ?? pack.summary.installedAt,
      enabled,
      sizeBytes: prev?.sizeBytes ?? pack.summary.sizeBytes,
      ...(prev?.sourceFile ? { sourceFile: prev.sourceFile } : {}),
      // Where it lives stays remembered — switching a pack off while its drive is away included.
      ...(prev?.vault ? { vault: prev.vault } : {}),
    };
    await this.writeState(state);
    await this.scan();
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
      createdAt: manifest.createdAt,
      ...(manifest.expiresAt !== undefined ? { expiresAt: manifest.expiresAt } : {}),
    };
    if (manifest.expiresAt !== undefined && this.clock.now() > Date.parse(manifest.expiresAt))
      summary.message = `expired on ${manifest.expiresAt.slice(0, 10)}`;
    if (this.trust.requireTrusted && !(signature.status === 'signed' && signature.trusted)) {
      summary.status = 'invalid';
      summary.message = 'not signed by one of your trusted publishers, which this app now requires';
    }
    return { summary, manifest, signature, dir, enabled };
  }

  /** A pack's index entries, validated — without building the in-memory postings. */
  private async loadEntries(dir: string): Promise<{ ok: true; entries: PlaceEntry[] } | { ok: false; error: string }> {
    const file = path.join(dir, ...WORLDPACK_SEARCH_INDEX_PATH.split('/'));
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_INDEX_BYTES) return { ok: false, error: `index larger than ${MAX_INDEX_BYTES} bytes` };
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      const r = serializedPlaceIndexSchema.parse(raw);
      if (!r.ok)
        return {
          ok: false,
          error: r.issues
            .slice(0, 10)
            .map((i) => `${i.path || '<root>'}: ${i.message}`)
            .join('; '),
        };
      return { ok: true, entries: r.value.entries };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  private async loadIndex(dir: string): Promise<{ ok: true; index: PlaceIndex } | { ok: false; error: string }> {
    const r = await this.loadEntries(dir);
    return r.ok ? { ok: true, index: new PlaceIndex(r.entries) } : r;
  }

  private async readState(): Promise<RegistryState> {
    const raw = await readJsonFile<Partial<RegistryState>>(path.join(this.root, STATE_FILE)).catch(() => undefined);
    const packs: Record<string, PackState> = {};
    if (raw && typeof raw === 'object' && raw.packs && typeof raw.packs === 'object') {
      for (const [id, v] of Object.entries(raw.packs)) {
        if (!v || typeof v !== 'object') continue;
        const p = v as Partial<PackState>;
        const vault = readPackVault(p.vault);
        packs[id] = {
          installedAt: typeof p.installedAt === 'string' ? p.installedAt : new Date(this.clock.now()).toISOString(),
          enabled: p.enabled !== false,
          sizeBytes: typeof p.sizeBytes === 'number' ? p.sizeBytes : 0,
          ...(typeof p.sourceFile === 'string' ? { sourceFile: p.sourceFile } : {}),
          ...(vault ? { vault } : {}),
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

/**
 * Why `next` may not replace the installed `current`, or undefined. An older pack does not
 * replace a newer one (remove the newer first to go back). A pack signed with a verified key
 * is replaced only by one signed with the same key or by one of the operator's publishers —
 * otherwise anyone could swap a publisher's pack for their own by reusing its id.
 */
export function replacementProblem(
  current: WorldPackManifest,
  currentSig: PackSignature | undefined,
  next: WorldPackManifest,
  nextSig: PackSignature | undefined,
): string | undefined {
  if (Date.parse(next.createdAt) < Date.parse(current.createdAt))
    return `older than the installed "${current.id}" pack (created ${current.createdAt.slice(0, 10)}, this one ${next.createdAt.slice(0, 10)}) — remove the installed pack first to go back`;
  if (currentSig?.status === 'signed') {
    const sameKey = nextSig?.status === 'signed' && nextSig.publicKey === currentSig.publicKey;
    const trusted = nextSig?.status === 'signed' && nextSig.trusted;
    if (!sameKey && !trusted)
      return `the installed "${current.id}" pack is signed with key ${formatKeyId(currentSig.keyId)}; this one is ${
        nextSig?.status === 'signed' ? `signed with key ${formatKeyId(nextSig.keyId)}` : 'not signed'
      } — remove the installed pack first to replace it with someone else's`;
  }
  return undefined;
}

function versionOf(m: WorldPackManifest): string {
  return m.version ?? m.createdAt.slice(0, 10);
}

/**
 * Make `<vault>/worldpacks/.staging` without ever creating anything above the vault root, check
 * that both folders are on the vault's device, and clear what an earlier, interrupted install of
 * ours left in staging. Returns why not, or undefined.
 */
async function prepareVaultStaging(
  vaultRoot: string,
  stagingRoot: string,
  device: number,
): Promise<string | undefined> {
  const packsDir = await vaultPacksDir(vaultRoot);
  if (!packsDir.ok) return packsDir.reason;
  for (const dir of [packsDir.dir, stagingRoot]) {
    try {
      await fs.mkdir(dir).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      });
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a folder on the vault`;
      if (st.dev !== device) return `${dir} is not on the vault's drive (was it unplugged?)`;
    } catch (err) {
      return `could not prepare ${dir}: ${errorText(err)}`;
    }
  }
  // Our own leftovers only: staging holds nothing else.
  for (const name of await fs.readdir(stagingRoot).catch(() => [] as string[]))
    await fs.rm(path.join(stagingRoot, name), { recursive: true, force: true }).catch(() => undefined);
  return undefined;
}

/** A remembered vault location from state.json, or undefined when it is not a well-formed one. */
function readPackVault(v: unknown): PackVaultState | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<PackVaultState>;
  if (typeof o.id !== 'string' || !/^[0-9a-f]{32}$/.test(o.id) || typeof o.label !== 'string') return undefined;
  const b = o.bounds;
  const bounds =
    b && [b.west, b.south, b.east, b.north].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { west: b.west, south: b.south, east: b.east, north: b.north }
      : { west: 0, south: 0, east: 0, north: 0 };
  return {
    id: o.id,
    label: o.label.slice(0, 80),
    name: typeof o.name === 'string' ? o.name.slice(0, 200) : '',
    version: typeof o.version === 'string' ? o.version.slice(0, 40) : '',
    bounds,
  };
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
