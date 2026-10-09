import { lstatSync, promises as fs, unlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from '@worldview/core';
import type {
  LocalApiError,
  LocalApiHealth,
  LocalApiIndex,
  LocalApiObject,
  LocalApiObjects,
  LocalApiOffline,
  LocalApiOwnPosition,
  LocalApiSources,
  LocalApiTrack,
  OfflineStatus,
  WorldTrackPoint,
} from '@worldview/ipc-contract';
import type { OwnPositionHealth, ProviderDataPolicy } from '@worldview/provider-sdk';
import type { ConnectionSnapshot, SourceHealthEntry } from '@worldview/source-health';
import { haversineMeters, type WorldObject } from '@worldview/world-model';

/**
 * The local read-only API (docs/adr/ADR-014-local-api.md, docs/cyberdeck M6): HTTP/1.1 GET over
 * a Unix socket that only this user can open, for another program on this computer (Formicaria).
 *
 * The router (`handleLocalApi`) is pure over its dependencies, so every rule is tested without a
 * socket: GET only, no request body, known parameters only, bounded answers, and every object
 * filtered by the data policies — an object is listed only if every source behind it allows its
 * data out of the app (`exportAllowed`); a Meshtastic mesh, whose policy says no, never is. This
 * computer's own position is a separate permission.
 */

export const LOCAL_API_LIMITS = Object.freeze({
  maxObjects: 500,
  defaultObjects: 100,
  maxRadiusKm: 500,
  defaultRadiusKm: 50,
  maxTrackHours: 24,
  requestsPerMinute: 120,
  maxUrlLength: 2048,
  maxResponseBytes: 4 * 1024 * 1024,
  requestTimeoutMs: 5000,
  maxConnections: 8,
});

export interface LocalApiDeps {
  now(): number;
  app: { version: string; channel: string; commit: string };
  /** Demo mode: everything is recorded or synthetic. */
  recorded(): boolean;
  ownPositionAllowed(): boolean;
  workOffline(): boolean;
  connection(): ConnectionSnapshot;
  sources(): readonly SourceHealthEntry[];
  policy(providerId: string): ProviderDataPolicy | undefined;
  objects(): Iterable<WorldObject>;
  /** Objects within `radiusM` of a point (the spatial index), any order. */
  objectsNear(center: { latitude: number; longitude: number }, radiusM: number): Iterable<WorldObject>;
  object(id: string): WorldObject | undefined;
  /** Every provider that has fed the object while in the world (beyond its capped sourceRefs). */
  contributors(id: string): readonly string[];
  /** Providers whose points are in the object's stored history for the range. */
  trackProviders(id: string, from: string, to: string): Promise<readonly string[]>;
  track(id: string, from: string, to: string): Promise<WorldTrackPoint[]>;
  offline(): OfflineStatus;
}

export interface LocalApiRequest {
  method: string;
  url: string;
  /** Declared body length, if any (a GET carries none). */
  contentLength?: number;
  chunked?: boolean;
}

export interface LocalApiResponse {
  status: number;
  body: unknown;
}

const ENDPOINTS = ['/v1', '/v1/health', '/v1/sources', '/v1/objects', '/v1/track', '/v1/offline', '/v1/own-position'];

function fail(status: number, code: LocalApiError['error']['code'], message: string): LocalApiResponse {
  return { status, body: { error: { code, message } } satisfies LocalApiError };
}

class BadRequest extends Error {}

function onlyParams(params: URLSearchParams, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw new BadRequest(`unknown parameter "${key.slice(0, 40)}"`);
    if (seen.has(key)) throw new BadRequest(`"${key}" given twice`);
    seen.add(key);
  }
}

function numberParam(params: URLSearchParams, key: string, min: number, max: number): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  if (!/^-?\d{1,4}(\.\d{1,8})?$/.test(raw)) throw new BadRequest(`"${key}" must be a number`);
  const n = Number(raw);
  if (n < min || n > max) throw new BadRequest(`"${key}" must be between ${min} and ${max}`);
  return n;
}

function timeParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  if (raw.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) throw new BadRequest(`"${key}" must be an ISO time`);
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new BadRequest(`"${key}" must be an ISO time`);
  return t;
}

/**
 * Every source behind an object: its provenance, its source refs, and every provider that has fed
 * it while in the world — refs are capped and a provider's merged labels and properties outlive
 * its ref, so the refs alone are not who is behind what the object says.
 */
function objectSources(o: WorldObject, deps: Pick<LocalApiDeps, 'contributors'>): string[] {
  return [
    ...new Set([o.provenance.providerId, ...o.sourceRefs.map((r) => r.providerId), ...deps.contributors(o.id)]),
  ].sort();
}

export function exportable(deps: Pick<LocalApiDeps, 'policy'>, providerIds: readonly string[]): boolean {
  return providerIds.length > 0 && providerIds.every((id) => deps.policy(id)?.exportAllowed === true);
}

function toApiObject(o: WorldObject, sources: string[]): LocalApiObject {
  const p = o.provenance;
  return {
    id: o.id,
    type: o.type,
    ...(o.position
      ? {
          position: {
            latitude: o.position.latitude,
            longitude: o.position.longitude,
            ...(o.position.altitudeM !== undefined ? { altitudeM: o.position.altitudeM } : {}),
          },
        }
      : {}),
    observedAt: o.observedAt,
    freshness: o.freshness,
    labels: { ...o.labels },
    ...(o.motion ? { motion: { ...o.motion } } : {}),
    provenance: {
      providerId: p.providerId,
      sourceName: p.sourceName,
      origin: p.origin,
      ...(p.attribution ? { attribution: p.attribution } : {}),
      ...(p.licenseId ? { licenseId: p.licenseId } : {}),
      receivedAt: p.receivedAt,
    },
    sources,
  };
}

const TYPE = /^[a-z][a-z0-9-]{0,40}$/;
const OBJECT_ID = /^[A-Za-z0-9:._!@-]{1,200}$/;

function objects(params: URLSearchParams, deps: LocalApiDeps): LocalApiResponse {
  onlyParams(params, ['lat', 'lon', 'radiusKm', 'type', 'since', 'limit', 'cursor']);
  const lat = numberParam(params, 'lat', -90, 90);
  const lon = numberParam(params, 'lon', -180, 180);
  if ((lat === undefined) !== (lon === undefined)) throw new BadRequest('"lat" and "lon" go together');
  const radiusKm = numberParam(params, 'radiusKm', 0.01, LOCAL_API_LIMITS.maxRadiusKm);
  if (radiusKm !== undefined && lat === undefined) throw new BadRequest('"radiusKm" needs "lat" and "lon"');
  const types = params.get('type')?.split(',');
  if (types && (types.length > 8 || !types.every((t) => TYPE.test(t))))
    throw new BadRequest('"type": up to 8 type names');
  const since = timeParam(params, 'since');
  const limit = numberParam(params, 'limit', 1, LOCAL_API_LIMITS.maxObjects) ?? LOCAL_API_LIMITS.defaultObjects;
  if (!Number.isInteger(limit)) throw new BadRequest('"limit" must be a whole number');
  let after: string | undefined;
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) throw new BadRequest('bad "cursor"');
    after = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!OBJECT_ID.test(after)) throw new BadRequest('bad "cursor"');
  }
  const centre = lat !== undefined && lon !== undefined ? { latitude: lat, longitude: lon } : undefined;
  const radiusM = (radiusKm ?? LOCAL_API_LIMITS.defaultRadiusKm) * 1000;
  // Filtered first, by the cheap tests; converted only for the page given back. Withheld objects
  // are not counted: a count under a query's filters would tell where they are.
  const candidates = centre ? deps.objectsNear(centre, radiusM) : deps.objects();
  const matched: Array<{ o: WorldObject; sources: string[] }> = [];
  for (const o of candidates) {
    if (after !== undefined && o.id <= after) continue;
    if (types && !types.includes(o.type)) continue;
    if (since !== undefined && Date.parse(o.observedAt) < since) continue;
    if (centre && (!o.position || haversineMeters(centre, o.position) > radiusM)) continue;
    const sources = objectSources(o, deps);
    if (!exportable(deps, sources)) continue;
    matched.push({ o, sources });
  }
  // Stable pages: by id, the cursor is the last id given.
  matched.sort((a, b) => (a.o.id < b.o.id ? -1 : a.o.id > b.o.id ? 1 : 0));
  const page = matched.slice(0, limit).map((m) => toApiObject(m.o, m.sources));
  const body: LocalApiObjects = {
    at: new Date(deps.now()).toISOString(),
    basis: 'live',
    recorded: deps.recorded(),
    objects: page,
    ...(matched.length > limit ? { next: Buffer.from(page[page.length - 1]!.id, 'utf8').toString('base64url') } : {}),
  };
  return { status: 200, body };
}

async function track(params: URLSearchParams, deps: LocalApiDeps): Promise<LocalApiResponse> {
  onlyParams(params, ['id', 'from', 'to']);
  const id = params.get('id');
  if (!id || !OBJECT_ID.test(id)) throw new BadRequest('"id" is required');
  const now = deps.now();
  const to = timeParam(params, 'to') ?? now;
  const from = timeParam(params, 'from') ?? to - 3_600_000;
  if (from >= to) throw new BadRequest('"from" must be before "to"');
  if (to - from > LOCAL_API_LIMITS.maxTrackHours * 3_600_000)
    throw new BadRequest(`at most ${LOCAL_API_LIMITS.maxTrackHours} hours`);
  const o = deps.object(id);
  if (!o) return fail(404, 'not-found', 'no such object now');
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  // A track is history: every provider with points in it — stored, or behind the live object —
  // must allow both keeping it and letting it out.
  const sources = [...new Set([...objectSources(o, deps), ...(await deps.trackProviders(id, fromIso, toIso))])];
  if (!exportable(deps, sources) || !sources.every((s) => deps.policy(s)?.normalizedRetentionAllowed === true))
    return fail(403, 'forbidden', "this object's sources do not allow their data out of the app");
  const points = await deps.track(id, fromIso, toIso);
  const body: LocalApiTrack = {
    id,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    points: points.slice(-5000).map((p) => ({
      at: p.observedAt,
      latitude: p.latitude,
      longitude: p.longitude,
      ...(p.altitudeM !== undefined ? { altitudeM: p.altitudeM } : {}),
      ...(p.source ? { source: p.source } : {}),
    })),
  };
  return { status: 200, body };
}

function ownPosition(deps: LocalApiDeps): LocalApiResponse {
  if (!deps.ownPositionAllowed())
    return fail(403, 'forbidden', "this computer's position is not shared: allow it in Settings → Local API");
  const at = new Date(deps.now()).toISOString();
  const source = deps.sources().find((s) => s.enabled && s.health.ownPosition);
  const own: OwnPositionHealth | undefined = source?.health.ownPosition;
  if (!source || !own) return { status: 200, body: { at, state: 'no-source' } satisfies LocalApiOwnPosition };
  // The coordinates come from that source's own node object, and only when there is a fix to give.
  let position: LocalApiOwnPosition['position'];
  if (own.state === 'fix' || own.state === 'stale' || own.state === 'unknown-age' || own.state === 'manual') {
    for (const o of deps.objects())
      if (o.provenance.providerId === source.providerId && o.properties['thisNode'] === true && o.position) {
        position = {
          latitude: o.position.latitude,
          longitude: o.position.longitude,
          ...(o.position.altitudeM !== undefined ? { altitudeM: o.position.altitudeM } : {}),
        };
        break;
      }
  }
  // A fix older than five minutes is said to be stale here too (the health was as at its report).
  let state = own.state;
  if (state === 'fix' && own.fixAt && deps.now() - Date.parse(own.fixAt) > 300_000) state = 'stale';
  const body: LocalApiOwnPosition = {
    at,
    state,
    ...(position ? { position } : {}),
    ...(own.fixAt ? { fixAt: own.fixAt } : {}),
    ...(own.satellites !== undefined ? { satellites: own.satellites } : {}),
    ...(own.fixType ? { fixType: own.fixType } : {}),
    ...(own.accuracyM !== undefined ? { accuracyM: own.accuracyM } : {}),
    source: { providerId: source.providerId, ...(own.node ? { node: own.node } : {}) },
  };
  return { status: 200, body };
}

export async function handleLocalApi(req: LocalApiRequest, deps: LocalApiDeps): Promise<LocalApiResponse> {
  if (req.method !== 'GET') return fail(405, 'method', 'read only: GET');
  if ((req.contentLength ?? 0) > 0 || req.chunked) return fail(413, 'too-large', 'a request carries no body');
  if (req.url.length > LOCAL_API_LIMITS.maxUrlLength) return fail(413, 'too-large', 'request too long');
  let url: URL;
  try {
    url = new URL(req.url, 'http://worldview.local');
  } catch {
    return fail(400, 'bad-request', 'bad request path');
  }
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const at = new Date(deps.now()).toISOString();
  try {
    switch (route) {
      case '/v1':
        onlyParams(url.searchParams, []);
        return {
          status: 200,
          body: {
            api: 'worldview-local',
            version: 1,
            app: { ...deps.app },
            endpoints: ENDPOINTS,
            ownPosition: deps.ownPositionAllowed(),
            limits: {
              maxObjects: LOCAL_API_LIMITS.maxObjects,
              maxRadiusKm: LOCAL_API_LIMITS.maxRadiusKm,
              maxTrackHours: LOCAL_API_LIMITS.maxTrackHours,
              requestsPerMinute: LOCAL_API_LIMITS.requestsPerMinute,
            },
          } satisfies LocalApiIndex,
        };
      case '/v1/health': {
        onlyParams(url.searchParams, []);
        const c = deps.connection();
        const sources = deps.sources().filter((s) => s.enabled);
        return {
          status: 200,
          body: {
            at,
            recorded: deps.recorded(),
            connection: { state: c.state, workOffline: deps.workOffline(), networkOnline: c.networkOnline },
            sources: { live: sources.filter((s) => s.health.status === 'LIVE').length, total: sources.length },
          } satisfies LocalApiHealth,
        };
      }
      case '/v1/sources':
        onlyParams(url.searchParams, []);
        return {
          status: 200,
          body: {
            at,
            sources: deps.sources().map((s) => {
              const readable = exportable(deps, [s.providerId]);
              // For a source whose data may not leave, its state only: not how much it holds or
              // when it last heard something (a mesh's size and activity are its members' data).
              return {
                providerId: s.providerId,
                name: s.name,
                locality: s.locality,
                enabled: s.enabled,
                status: s.health.status,
                ...(readable && s.health.lastObservation ? { lastObservation: s.health.lastObservation } : {}),
                ...(readable && s.health.objectCount !== undefined ? { objectCount: s.health.objectCount } : {}),
                readable,
              };
            }),
          } satisfies LocalApiSources,
        };
      case '/v1/objects':
        return objects(url.searchParams, deps);
      case '/v1/track':
        return await track(url.searchParams, deps);
      case '/v1/offline': {
        onlyParams(url.searchParams, []);
        const o = deps.offline();
        return {
          status: 200,
          body: {
            at,
            connection: o.connection.state,
            workOffline: deps.workOffline(),
            capabilities: { ...o.capabilities },
            packs: o.packs.map((p) => ({ id: p.id, name: p.name, status: p.status })),
            // Labels and states, not paths: where the operator's drives are mounted stays here.
            vaults: (o.vaults ?? []).map((v) => ({
              label: v.label,
              state: v.state,
              ...(v.freeBytes !== undefined ? { freeBytes: v.freeBytes } : {}),
            })),
          } satisfies LocalApiOffline,
        };
      }
      case '/v1/own-position':
        onlyParams(url.searchParams, []);
        return ownPosition(deps);
      default:
        return fail(404, 'not-found', 'no such endpoint; see /v1');
    }
  } catch (err) {
    if (err instanceof BadRequest) return fail(400, 'bad-request', err.message);
    throw err;
  }
}

// ---- the socket -----------------------------------------------------------------------------

export interface LocalApiServerOptions {
  socketPath: string;
  deps: LocalApiDeps;
  log: Logger;
}

/**
 * Where the socket goes: `$XDG_RUNTIME_DIR/worldview/api.sock` — the per-user runtime folder the
 * login session creates (mode 0700, on tmpfs, removed at logout). No XDG_RUNTIME_DIR, no API:
 * a socket in a shared /tmp is exactly what this design avoids.
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env['XDG_RUNTIME_DIR'];
  return dir && path.isAbsolute(dir) ? path.join(dir, 'worldview', 'api.sock') : undefined;
}

/** Whether something answers on a Unix socket (a live server, not a file left behind). */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(socketPath);
    const done = (v: boolean) => {
      c.destroy();
      resolve(v);
    };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    c.setTimeout(1000, () => done(false));
  });
}

export class LocalApiServer {
  private server: http.Server | undefined;
  private inode: number | undefined;
  private window: number[] = [];
  private closing = false;

  constructor(private readonly opts: LocalApiServerOptions) {}

  get listening(): boolean {
    return this.server?.listening === true;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  /**
   * Make the folder (0700, ours, not a link), clear a stale socket of ours, listen, and make the
   * socket 0600. Anything unexpected at that path — another user's folder, a link, a file that
   * is not a socket — is refused, never overwritten.
   */
  async start(): Promise<void> {
    if (this.server) return;
    const { socketPath, log } = this.opts;
    const dir = path.dirname(socketPath);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    // The folder holding ours must be this user's and closed to others (the session's runtime
    // folder is 0700): otherwise someone else could swap our folder for theirs.
    const parent = await fs.lstat(path.dirname(dir));
    if (!parent.isDirectory()) throw new Error(`${path.dirname(dir)} is not a folder`);
    if (uid !== undefined && parent.uid !== uid) throw new Error(`${path.dirname(dir)} belongs to another user`);
    if ((parent.mode & 0o022) !== 0) throw new Error(`${path.dirname(dir)} can be written by other users`);
    await fs.mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    const dst = await fs.lstat(dir);
    if (!dst.isDirectory() || dst.isSymbolicLink()) throw new Error(`${dir} is not a folder`);
    if (uid !== undefined && dst.uid !== uid) throw new Error(`${dir} belongs to another user`);
    if ((dst.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
    const existing = await fs.lstat(socketPath).catch(() => undefined);
    if (existing) {
      if (!existing.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
      if (uid !== undefined && existing.uid !== uid) throw new Error(`${socketPath} belongs to another user`);
      // Another WORLDVIEW (a second profile, a development build) answering there: leave it be.
      if (await answers(socketPath)) throw new Error(`another WORLDVIEW is serving ${socketPath}`);
      await fs.unlink(socketPath); // left by a run that did not close cleanly
    }
    const server = http.createServer(
      // Timeouts are checked every second, not Node's default thirty.
      { maxHeaderSize: 8192, connectionsCheckingInterval: 1000 },
      (req, res) => void this.serve(req, res),
    );
    server.requestTimeout = LOCAL_API_LIMITS.requestTimeoutMs;
    server.headersTimeout = LOCAL_API_LIMITS.requestTimeoutMs;
    server.keepAliveTimeout = 1000;
    server.maxConnections = LOCAL_API_LIMITS.maxConnections;
    server.maxHeadersCount = 32;
    const listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        resolve();
      });
    });
    // The socket file is made inside listen(), synchronously, with the umask: tightened for
    // exactly that call and restored straight after, so no other file the process makes
    // meanwhile is affected.
    const oldUmask = process.umask(0o177);
    try {
      server.listen(socketPath);
    } finally {
      process.umask(oldUmask);
    }
    try {
      await listening;
      await fs.chmod(socketPath, 0o600);
      this.inode = (await fs.lstat(socketPath)).ino;
    } catch (err) {
      // Never leave a listener nobody can turn off.
      server.close();
      if (this.inode === undefined) await fs.unlink(socketPath).catch(() => undefined);
      throw err;
    }
    this.server = server;
    log.info('local API listening', { socket: socketPath });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.closing = true;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await this.removeSocket();
    this.closing = false;
    this.opts.log.info('local API stopped', {});
  }

  /** On quit, when there is no time to wait: stop listening and remove the socket now. */
  closeNow(): void {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.close();
    server.closeAllConnections?.();
    try {
      if (lstatSync(this.opts.socketPath).ino === this.inode) unlinkSync(this.opts.socketPath);
    } catch {
      /* already gone */
    }
  }

  /** Remove the socket only if it is still the one this server made (not a later instance's). */
  private async removeSocket(): Promise<void> {
    const st = await fs.lstat(this.opts.socketPath).catch(() => undefined);
    if (st && st.ino === this.inode) await fs.unlink(this.opts.socketPath).catch(() => undefined);
    this.inode = undefined;
  }

  private allow(): boolean {
    const now = Date.now();
    while (this.window.length && now - this.window[0]! >= 60_000) this.window.shift();
    if (this.window.length >= LOCAL_API_LIMITS.requestsPerMinute) return false;
    this.window.push(now);
    return true;
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    req.pause();
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    const send = (status: number, body: unknown) => {
      let text = JSON.stringify(body);
      if (Buffer.byteLength(text) > LOCAL_API_LIMITS.maxResponseBytes) {
        status = 500;
        text = JSON.stringify({ error: { code: 'too-large', message: 'answer too large; ask for less' } });
      }
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(hasBody ? { connection: 'close' } : {}),
      });
      res.end(text);
    };
    // A body is never read: the request is answered (405/413) and the connection closed behind it.
    if (this.closing) return send(503, { error: { code: 'unavailable', message: 'shutting down' } });
    if (!this.allow()) return send(429, { error: { code: 'rate-limited', message: 'too many requests' } });
    try {
      const len = req.headers['content-length'];
      const r = await handleLocalApi(
        {
          method: req.method ?? '',
          url: req.url ?? '',
          ...(len !== undefined ? { contentLength: Number(len) || 1 } : {}),
          ...(req.headers['transfer-encoding'] ? { chunked: true } : {}),
        },
        this.opts.deps,
      );
      send(r.status, r.body);
      if (r.status >= 400 && r.status !== 404)
        this.opts.log.info('local API refused', { status: r.status, path: (req.url ?? '').slice(0, 120) });
    } catch (err) {
      this.opts.log.warn('local API failed', { message: err instanceof Error ? err.message : String(err) });
      send(500, { error: { code: 'unavailable', message: 'internal error' } });
    }
  }
}
