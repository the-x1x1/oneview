import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GeoBounds } from '@worldview/world-model';
import type { TileCacheStatus } from '@worldview/ipc-contract';
import { silentLogger, type Logger } from '@worldview/core';

/**
 * Map tiles kept on disk, served to the page from `worldview://app/__tiles/…`.
 *
 * The globe and the flat map both asked Esri for every tile, every time: Cesium keeps a few
 * hundred in memory and Chromium keeps what the server's cache headers allow, so a place
 * visited yesterday loaded from the network again today, and nothing loaded offline. This
 * keeps every tile that has been drawn, up to a size the operator sets (Settings → Map tile
 * cache), dropping the least recently used first. It also fetches ahead: when the camera
 * settles, the next two zoom levels of what is on screen, so zooming in lands on tiles that
 * are already here. And if the operator turns it on, the whole globe down to zoom 7.
 *
 * Only sources whose catalog entry has a `tileCache` block are served (render-core
 * map-providers.ts); every other basemap goes to the network as before. That is deliberate:
 * OpenStreetMap's tile policy forbids offline use and bulk fetching, and the switch for the
 * one source that allows a preload at all is the operator's, never a default.
 *
 * It is not a proxy. A request names a catalog source and three integers; the upstream URL
 * is built from the catalog's own template. Anything else is a 404.
 */
export interface TileSourceConfig {
  id: string;
  /** Upstream template with `{z}`, `{x}` and `{y}`. */
  upstream: string;
  maxZoom: number;
  /** May be preloaded to `WORLD_PRELOAD_MAX_ZOOM` when the operator asks for it. */
  worldPreload: boolean;
}

export interface FetchLike {
  (
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> },
  ): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface TileCacheOptions {
  dir: string;
  sources: readonly TileSourceConfig[];
  fetch: FetchLike;
  maxMB: number;
  now?: () => number;
  logger?: Logger;
  /** Pause between background fetches, per worker (ms). Keeps prefetch polite. */
  backgroundDelayMs?: number;
  /** Concurrent background fetches. */
  backgroundConcurrency?: number;
  /** Deepest level of the world preload (default `WORLD_PRELOAD_MAX_ZOOM`); lower in tests. */
  preloadMaxZoom?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const TILE_ROUTE_PREFIX = '/__tiles/';
export const WORLD_PRELOAD_MAX_ZOOM = 7;
/** Tiles in zoom 0–`maxZoom`: (4^(maxZoom+1) − 1) / 3 — 21,845 for zoom 7. */
export function worldPreloadTiles(maxZoom: number = WORLD_PRELOAD_MAX_ZOOM): number {
  return (4 ** (maxZoom + 1) - 1) / 3;
}
/** A prefetch fetches at most this many tiles per level, and skips a level with more. */
export const PREFETCH_MAX_PER_LEVEL = 64;
const FETCH_TIMEOUT_MS = 15_000;
/** Evict down to this share of the cap, so the next few tiles do not each trigger a sweep. */
const EVICT_TO = 0.9;
/** The world preload stops once the cache is this full, rather than evicting what it just fetched. */
const PRELOAD_STOP_AT = 0.8;
/** Refresh a tile's last-used time on disk at most this often (it is what survives a restart). */
const TOUCH_EVERY_MS = 6 * 3600_000;

interface Entry {
  bytes: number;
  used: number;
  touched: number;
}

interface TileKey {
  sourceId: string;
  z: number;
  x: number;
  y: number;
}

const TILE_PATH = /^\/__tiles\/([a-z0-9][a-z0-9-]{0,63})\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/;

/** `/__tiles/<source>/<z>/<x>/<y>` → its parts, or undefined for anything malformed or out of range. */
export function parseTilePath(pathname: string): TileKey | undefined {
  const m = TILE_PATH.exec(pathname);
  if (!m) return undefined;
  const z = Number(m[2]);
  const x = Number(m[3]);
  const y = Number(m[4]);
  if (z > 24) return undefined;
  const n = 2 ** z;
  if (x >= n || y >= n) return undefined;
  return { sourceId: m[1]!, z, x, y };
}

export function upstreamUrl(template: string, z: number, x: number, y: number): string {
  return template.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
}

/** Web Mercator tile ranges covering `bounds` at level `z` (two when it crosses the antimeridian). */
export function tilesCovering(bounds: GeoBounds, z: number): Array<{ x0: number; x1: number; y0: number; y1: number }> {
  const n = 2 ** z;
  const lat = (v: number) => Math.max(-85.05112878, Math.min(85.05112878, v));
  const tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const ty = (latDeg: number) => {
    const r = (lat(latDeg) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  const y0 = ty(bounds.north);
  const y1 = ty(bounds.south);
  if (bounds.west <= bounds.east) return [{ x0: tx(bounds.west), x1: tx(bounds.east), y0, y1 }];
  return [
    { x0: tx(bounds.west), x1: n - 1, y0, y1 },
    { x0: 0, x1: tx(bounds.east), y0, y1 },
  ];
}

/** What the bytes are, from their first bytes. Anything that is not an image is not cached. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

type TileResult = { bytes: Uint8Array; contentType: string; cached: boolean } | { status: number; reason: string };

export class TileCache {
  private readonly sources: Map<string, TileSourceConfig>;
  private readonly index = new Map<string, Entry>();
  private total = 0;
  private maxBytes: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight = new Map<string, Promise<TileResult>>();
  private foreground = 0;
  private prefetchQueue: TileKey[] = [];
  private preload: {
    sourceId: string;
    iterator: Iterator<TileKey>;
    done: number;
    state: TileCacheStatus['preload']['state'];
    message?: string;
    /** Every tile has been handed to a worker; done once the last of them lands. */
    exhausted?: boolean;
  } | null = null;
  private workers = 0;
  private evicting: Promise<void> | null = null;
  private scanned = false;
  private disposed = false;
  private readonly preloadMaxZoom: number;
  private scanning: Promise<void> | undefined;

  constructor(private readonly opts: TileCacheOptions) {
    this.preloadMaxZoom = opts.preloadMaxZoom ?? WORLD_PRELOAD_MAX_ZOOM;
    this.sources = new Map(opts.sources.map((s) => [s.id, s]));
    this.maxBytes = Math.max(64, opts.maxMB) * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Read what is already on disk. Tiles are served before this finishes; only eviction waits for it. */
  init(): Promise<void> {
    this.scanning ??= this.scan();
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const started = this.now();
    for (const source of this.sources.keys()) {
      const root = path.join(this.opts.dir, source);
      let names: string[];
      try {
        names = (await fs.readdir(root, { recursive: true })) as string[];
      } catch {
        continue;
      }
      for (const rel of names) {
        if (!rel.endsWith('.bin')) continue;
        const parts = rel.split(/[\\/]/);
        if (parts.length !== 3) continue;
        const [z, x, file] = parts as [string, string, string];
        const key = `${source}/${z}/${x}/${file.slice(0, -4)}`;
        if (this.index.has(key)) continue;
        try {
          const st = await fs.stat(path.join(root, rel));
          this.index.set(key, { bytes: st.size, used: st.mtimeMs, touched: st.mtimeMs });
          this.total += st.size;
        } catch {
          /* removed while scanning */
        }
      }
    }
    this.scanned = true;
    this.log.info('tile cache ready', {
      tiles: this.index.size,
      mb: Math.round(this.total / 1048576),
      capMb: Math.round(this.maxBytes / 1048576),
      scanMs: Math.round(this.now() - started),
    });
    this.scheduleEvict();
  }

  /** The protocol handler's half: a Response for a `/__tiles/…` URL. */
  async respond(pathname: string): Promise<Response> {
    const key = parseTilePath(pathname);
    if (!key || !this.sources.has(key.sourceId)) return new Response('Not found', { status: 404 });
    this.foreground++;
    try {
      const r = await this.tile(key);
      if ('status' in r) return new Response(r.reason, { status: r.status, headers: { 'Content-Type': 'text/plain' } });
      return new Response(r.bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { 'Content-Type': r.contentType, 'X-Worldview-Tile-Cache': r.cached ? 'hit' : 'miss' },
      });
    } finally {
      this.foreground--;
    }
  }

  private file(key: TileKey): string {
    return path.join(this.opts.dir, key.sourceId, String(key.z), String(key.x), `${key.y}.bin`);
  }

  private id(key: TileKey): string {
    return `${key.sourceId}/${key.z}/${key.x}/${key.y}`;
  }

  /** From disk if it is there, otherwise from upstream (and then to disk). Concurrent asks share one fetch. */
  private tile(key: TileKey): Promise<TileResult> {
    const id = this.id(key);
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const p = this.load(key, id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async load(key: TileKey, id: string): Promise<TileResult> {
    const source = this.sources.get(key.sourceId)!;
    if (key.z > source.maxZoom) return { status: 404, reason: 'beyond the source’s deepest level' };
    const file = this.file(key);
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      const contentType = sniffImage(bytes);
      if (contentType) {
        this.noteUse(id, file, bytes.length);
        return { bytes, contentType, cached: true };
      }
    } catch {
      /* not cached */
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.opts.fetch(upstreamUrl(source.upstream, key.z, key.x, key.y), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5' },
      });
    } catch (error) {
      return { status: 503, reason: `upstream unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!res.ok) return { status: res.status === 404 ? 404 : 502, reason: `upstream answered ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = sniffImage(bytes);
    if (!contentType) return { status: 502, reason: 'upstream answered with something that is not an image' };
    await this.store(id, file, bytes);
    return { bytes, contentType, cached: false };
  }

  private noteUse(id: string, file: string, bytes: number): void {
    const t = this.now();
    const e = this.index.get(id);
    if (!e) {
      this.index.set(id, { bytes, used: t, touched: t });
      this.total += bytes;
      return;
    }
    e.used = t;
    if (t - e.touched > TOUCH_EVERY_MS) {
      e.touched = t;
      const when = new Date(t);
      void fs.utimes(file, when, when).catch(() => undefined);
    }
  }

  private async store(id: string, file: string, bytes: Uint8Array): Promise<void> {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file);
    } catch (error) {
      this.log.warn('tile cache write failed', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const t = this.now();
    const previous = this.index.get(id);
    if (previous) this.total -= previous.bytes;
    this.index.set(id, { bytes: bytes.length, used: t, touched: t });
    this.total += bytes.length;
    if (this.total > this.maxBytes) this.scheduleEvict();
  }

  private scheduleEvict(): void {
    if (this.evicting || !this.scanned || this.total <= this.maxBytes) return;
    this.evicting = this.evict().finally(() => {
      this.evicting = null;
    });
  }

  private async evict(): Promise<void> {
    const target = this.maxBytes * EVICT_TO;
    const oldest = [...this.index.entries()].sort((a, b) => a[1].used - b[1].used);
    let removed = 0;
    for (const [id, e] of oldest) {
      if (this.total <= target) break;
      const [sourceId, z, x, y] = id.split('/') as [string, string, string, string];
      await fs.rm(this.file({ sourceId, z: +z, x: +x, y: +y }), { force: true }).catch(() => undefined);
      this.index.delete(id);
      this.total -= e.bytes;
      removed++;
    }
    if (removed) this.log.info('tile cache trimmed', { removed, mb: Math.round(this.total / 1048576) });
  }

  // ── settings ──────────────────────────────────────────────────────────────

  /** Apply the operator's settings: the size cap, and whether to preload the world for `basemapId`. */
  configure(settings: { maxMB: number; preloadWorld: boolean }, basemapId: string): void {
    this.maxBytes = Math.max(64, settings.maxMB) * 1024 * 1024;
    this.scheduleEvict();
    const source = this.sources.get(basemapId);
    const want = settings.preloadWorld && source?.worldPreload ? basemapId : null;
    if (!want) {
      if (this.preload && this.preload.state === 'running') this.log.info('world preload stopped', {});
      this.preload = null;
      return;
    }
    if (this.preload?.sourceId === want && this.preload.state !== 'stopped') return;
    this.preload = { sourceId: want, iterator: worldTiles(want, this.preloadMaxZoom), done: 0, state: 'running' };
    this.log.info('world preload started', { source: want, tiles: worldPreloadTiles(this.preloadMaxZoom) });
    this.pump();
  }

  // ── prefetch ──────────────────────────────────────────────────────────────

  /**
   * The camera has settled on `bounds` at `zoom`: fetch the next two levels of it. Replaces
   * any prefetch still waiting — only where the camera is now matters. Returns how many tiles
   * were queued.
   */
  prefetch(sourceId: string, bounds: GeoBounds, zoom: number): number {
    const source = this.sources.get(sourceId);
    if (!source || this.disposed) return 0;
    const queue: TileKey[] = [];
    const first = Math.max(0, Math.floor(zoom) + 1);
    for (let z = first; z <= Math.min(source.maxZoom, first + 1); z++) {
      const level: TileKey[] = [];
      for (const r of tilesCovering(bounds, z))
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) level.push({ sourceId, z, x, y });
      if (level.length > PREFETCH_MAX_PER_LEVEL) continue;
      queue.push(...level.filter((k) => !this.index.has(this.id(k))));
    }
    // Counted before the workers start: they take from this same array as they go.
    const queued = queue.length;
    this.prefetchQueue = queue;
    this.pump();
    return queued;
  }

  private next(): TileKey | undefined {
    const p = this.prefetchQueue.shift();
    if (p) return p;
    const pre = this.preload;
    if (!pre || pre.state !== 'running') return undefined;
    if (this.total > this.maxBytes * PRELOAD_STOP_AT) {
      pre.state = 'stopped';
      pre.message = 'The cache is nearly full. Raise the size cap to preload the rest.';
      this.log.info('world preload stopped: cache nearly full', { done: pre.done });
      return undefined;
    }
    for (;;) {
      const n = pre.iterator.next();
      if (n.done) {
        pre.exhausted = true;
        return undefined;
      }
      pre.done++;
      if (!this.index.has(this.id(n.value))) return n.value;
    }
  }

  private pump(): void {
    const max = this.opts.backgroundConcurrency ?? 3;
    while (this.workers < max && !this.disposed) {
      this.workers++;
      void this.work().finally(() => {
        this.workers--;
        const pre = this.preload;
        if (this.workers === 0 && pre?.exhausted && pre.state === 'running') {
          pre.state = 'done';
          this.log.info('world preload complete', { tiles: pre.done });
        }
      });
    }
  }

  private async work(): Promise<void> {
    const delay = this.opts.backgroundDelayMs ?? 60;
    for (;;) {
      if (this.disposed) return;
      // What is on screen comes first: background fetches wait while the page is loading tiles.
      while (this.foreground > 0 && !this.disposed) await this.sleep(50);
      const key = this.next();
      if (!key) return;
      const r = await this.tile(key);
      if ('status' in r && r.status === 503 && this.preload?.state === 'running' && !this.prefetchQueue.length) {
        // Offline: stop asking; the next configure() or prefetch starts again.
        this.preload.state = 'stopped';
        this.preload.message = 'Could not reach the tile server; the preload resumes when you next change the setting.';
        return;
      }
      if (delay) await this.sleep(delay);
    }
  }

  // ── status ────────────────────────────────────────────────────────────────

  status(): TileCacheStatus {
    const pre = this.preload;
    return {
      available: true,
      bytes: this.total,
      tiles: this.index.size,
      maxBytes: this.maxBytes,
      preload: pre
        ? {
            state: pre.state,
            done: pre.done,
            total: worldPreloadTiles(this.preloadMaxZoom),
            ...(pre.message ? { message: pre.message } : {}),
          }
        : { state: 'off', done: 0, total: worldPreloadTiles(this.preloadMaxZoom) },
    };
  }

  /**
   * The sources with at least one tile on disk, once the startup scan has read them — what
   * lets an offline map keep a cached source selectable (resolveMapProviders).
   */
  async sourcesWithTiles(): Promise<string[]> {
    await this.init().catch(() => undefined);
    const found = new Set<string>();
    for (const id of this.index.keys()) {
      found.add(id.slice(0, id.indexOf('/')));
      if (found.size === this.sources.size) break;
    }
    return [...found];
  }

  async clear(): Promise<TileCacheStatus> {
    this.prefetchQueue = [];
    for (const source of this.sources.keys())
      await fs.rm(path.join(this.opts.dir, source), { recursive: true, force: true }).catch(() => undefined);
    this.index.clear();
    this.total = 0;
    if (this.preload) {
      this.preload = {
        ...this.preload,
        iterator: worldTiles(this.preload.sourceId, this.preloadMaxZoom),
        done: 0,
        state: 'running',
      };
      delete this.preload.message;
      this.pump();
    }
    this.log.info('tile cache cleared', {});
    return this.status();
  }

  dispose(): void {
    this.disposed = true;
    this.prefetchQueue = [];
  }
}

function* worldTiles(sourceId: string, maxZoom: number): Generator<TileKey> {
  for (let z = 0; z <= maxZoom; z++) {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) yield { sourceId, z, x, y };
  }
}
