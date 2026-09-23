import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  EventTypes,
  formatIssues,
  worldQuerySchema,
  type GeoBounds,
  type JsonValue,
  type TimeRange,
  type WorldEvent,
  type WorldObject,
  type WorldQuery,
  type WorldQueryResult,
} from '@worldview/world-model';
import type { TrackPoint } from '@worldview/state-engine';
import { mayExport } from '@worldview/provider-sdk';
import {
  applyObjectQuery,
  executeEventQuery,
  executeQuery,
  executeQueryWithHistory,
  searchWorld,
} from '@worldview/query-engine';
import { whatChanged } from '@worldview/event-engine';
import { placeHitToSearchResult } from '@worldview/offline';
import { exportBundle } from '@worldview/diagnostics';
import {
  EVENT_TYPE_LABELS,
  type AppSettings,
  type DiagnosticsSnapshot,
  type EventTypeInfo,
  type SearchResult,
  type TileCacheStatus,
  type TimelineState,
  type WorldSubscription,
} from '@worldview/ipc-contract';
import type { RequestHandlers } from './contract.js';
import { MAP_PROVIDER_CATALOG, resolveMapProviders } from '@worldview/render-core';
import { RuntimeCore, errorText } from './core.js';
import { filterObjects } from './support/subscriptions.js';
import {
  DeniedError,
  InvalidRequestError,
  NotFoundError,
  requireCollection,
  requireLens,
  requireWatchZone,
  validateCollection,
  validateRegion,
} from './validate.js';

const MAX_EXPORT_ROWS = 200_000;

/**
 * Every IPC channel, implemented once. The desktop's IPC router and the in-process client
 * call exactly this table; main may override individual channels (native dialogs, the
 * safeStorage credential store), but a channel is never left unimplemented here.
 */
export function createHandlers(core: RuntimeCore): RequestHandlers {
  const handlers: RequestHandlers = {
    // ---- app -----------------------------------------------------------------
    'app.info': async () => ({
      version: core.version,
      channel: core.channel,
      commit: core.commit,
      demoMode: core.demoMode(),
      platform: core.platform,
    }),
    'app.openExternal': async ({ url }) => {
      const target = externalUrl(url, core.externalHostAllowlist());
      const opened = await core.hostBridge.openExternal(target);
      return { opened };
    },

    // ---- settings ------------------------------------------------------------
    'settings.get': async () => core.settingsSnapshot(),
    'settings.set': async (patch) => {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
        throw new InvalidRequestError('settings patch must be an object');
      let next: AppSettings;
      try {
        next = await core.settings.patch(patch as Partial<AppSettings>);
      } catch (err) {
        throw new InvalidRequestError(errorText(err));
      }
      // Provider enablement is applied to the live host, not just persisted.
      const providers = (patch as Partial<AppSettings>).providers;
      if (providers) {
        for (const [providerId, value] of Object.entries(providers)) {
          if (core.providerHost.manifest(providerId)) await core.providerHost.setEnabled(providerId, value.enabled);
        }
      }
      // An operator-supplied sidecar path takes effect now, not at the next launch.
      if ((patch as Partial<AppSettings>).cameras) await core.applyGo2rtcSetting();
      core.updater.applyPolicy();
      return { ...next, providers: core.settingsSnapshot().providers, demoMode: core.demoMode() };
    },

    // ---- map providers -------------------------------------------------------
    'map.providers.list': async () => {
      const settings = core.settingsSnapshot();
      const configured = new Set<string>();
      for (const entry of MAP_PROVIDER_CATALOG) {
        if (entry.requiresCredential && (await core.credentials.has(entry.requiresCredential)))
          configured.add(entry.requiresCredential);
      }
      const online = core.providerHost.isOnline();
      const resolved = resolveMapProviders({
        credentials: configured,
        offlineBasemapAvailable: core.packs.pmtilesPaths().length > 0,
        online,
        // Only asked for offline: it waits for the cache's startup scan, and online the
        // answer changes nothing.
        cachedTileSources: online ? [] : await core.cachedTileSources(),
      });
      return {
        basemaps: resolved.filter((e) => e.kind === 'basemap'),
        terrains: resolved.filter((e) => e.kind === 'terrain'),
        activeBasemapId: settings.basemapId,
        activeTerrainId: settings.terrainId,
      };
    },

    /**
     * Which event types a watch zone can usefully subscribe to. A type is available when
     * something in *this* build can produce it: a registered rule whose object types an
     * enabled provider supplies, or one of the two the engine raises itself. The
     * interface used to carry a hardcoded list that included `satellite-decay` (no rule
     * produces it anywhere) and `launch` (a rule exists, no launch provider ships) while
     * omitting `watch-zone-entry`, which the evaluator requires for aircraft and vessel
     * entry alerts — so two boxes did nothing and the one that mattered was unreachable.
     */
    'events.types.list': async () => {
      const rules = core.events.activeRules();
      const enabled = core.providerHost.health.list().filter((e) => e.enabled);
      const suppliedTypes = new Set<string>();
      for (const entry of enabled) {
        for (const t of core.providerHost.manifest(entry.providerId)?.objectTypes ?? []) suppliedTypes.add(t);
      }
      const out: EventTypeInfo[] = [];
      for (const type of Object.values(EventTypes) as string[]) {
        const label = EVENT_TYPE_LABELS[type] ?? type;
        if (type === EventTypes.WatchZoneEntry || type === EventTypes.SourceStatusChange) {
          out.push({ type, label, available: true, objectTypes: [] });
          continue;
        }
        const rule = rules.find((r) => r.eventTypes.includes(type));
        if (!rule) {
          out.push({
            type,
            label,
            available: false,
            unavailableReason: 'No rule in this build produces this event',
            objectTypes: [],
          });
          continue;
        }
        const objectTypes = [...rule.objectTypes];
        const supplied = objectTypes.filter((t) => suppliedTypes.has(t));
        out.push(
          supplied.length > 0
            ? { type, label, available: true, objectTypes }
            : {
                type,
                label,
                available: false,
                unavailableReason: `No enabled source provides ${objectTypes.join(' or ')}`,
                objectTypes,
              },
        );
      }
      return out;
    },

    // ---- world ---------------------------------------------------------------
    'world.query': async (request) => {
      const query = parseQuery(request);
      if (!core.isLive()) {
        const objects = await core.activeObjects();
        return applyObjectQuery(objects, stripTime(query), 'historical', core.clock.now());
      }
      if (query.time)
        return executeQueryWithHistory(query, {
          state: core.state,
          history: core.historyReader,
          now: () => core.clock.now(),
        });
      return executeQuery(query, { state: core.state, now: () => core.clock.now() });
    },
    'world.get': async ({ objectId }) => {
      requireId(objectId, 'objectId');
      if (core.isLive()) return core.state.get(objectId) ?? null;
      for (const o of await core.activeObjects()) if (o.id === objectId) return o;
      return null;
    },
    'world.track': async ({ objectId, time }) => {
      requireId(objectId, 'objectId');
      const range = time ?? {
        start: new Date(core.clock.now() - 3_600_000).toISOString(),
        end: new Date(core.clock.now()).toISOString(),
      };
      requireRange(range);
      const live = core.state.track(objectId);
      // A history read that fails would otherwise be indistinguishable from an object
      // with no recorded track: the caller would be shown a short trail and told
      // nothing. The failure is logged and surfaced on the result instead.
      let persisted: TrackPoint[] = [];
      let historyError: string | undefined;
      try {
        persisted = await core.history.track(objectId, range);
      } catch (err) {
        historyError = errorText(err);
        core.log.warn('history track read failed', { objectId, error: historyError });
      }
      core.noteHistoryRead(historyError);
      // History is authoritative for the requested window; live track points fill the tail.
      const seen = new Set(persisted.map((p) => p.observedAt));
      const merged = [...persisted, ...live.filter((p) => !seen.has(p.observedAt) && within(range, p.observedAt))];
      merged.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      return merged;
    },
    'world.events': async (request) => {
      const query = parseQuery(request);
      return executeEventQuery(query, { events: core.events.store, now: () => core.clock.now() });
    },
    'world.event': async ({ eventId }) => {
      requireId(eventId, 'eventId');
      return core.events.store.get(eventId) ?? null;
    },
    'world.subscribe': async (request, ctx) => {
      const subscription = parseSubscription(request);
      core.subscriptions.set(ctx.clientId, subscription);
      const objects = await core.activeObjects();
      const snapshot = filterObjects(objects, subscription);
      return { snapshot, count: snapshot.length };
    },
    'world.related': async ({ objectId, eventId }) => {
      if (!objectId && !eventId) throw new InvalidRequestError('world.related needs objectId or eventId');
      const objects: WorldObject[] = [];
      const events: WorldEvent[] = [];
      if (eventId) {
        const event = core.events.store.get(eventId);
        if (event) {
          events.push(...core.events.store.related({ eventId }));
          for (const id of event.objectIds) {
            const o = core.state.get(id);
            if (o) objects.push(o);
          }
        }
      }
      if (objectId) {
        events.push(...core.events.store.related({ objectId }));
        const object = core.state.get(objectId);
        // Proximity, nothing more: the eight nearest objects of any type within 250 km.
        // "Related" in the panel means "also here", and the panel labels it that way —
        // no provider, category or causal relationship is inferred from position.
        if (object?.position) {
          for (const near of core.state.nearest(object.position, 8, undefined, 250_000)) {
            if (near.object.id !== objectId) objects.push(near.object);
          }
        }
      }
      return { objects: dedupeById(objects), events: dedupeById(events) };
    },
    'world.whatChanged': async ({ region, time }) => {
      const parsedRegion = validateRegion(region);
      if (!parsedRegion) throw new InvalidRequestError('invalid region');
      requireRange(time);
      return whatChanged(
        { region: parsedRegion, time },
        {
          events: core.events.store,
          state: core.state,
          history: core.historyReader,
          now: () => core.clock.now(),
        },
      );
    },
    'world.viewport': async ({ bounds, zoom }) => {
      if (!isBounds(bounds) || typeof zoom !== 'number' || !Number.isFinite(zoom))
        throw new InvalidRequestError('invalid viewport');
      core.setViewport(bounds);
    },

    // ---- sources -------------------------------------------------------------
    'sources.list': async () => core.providerHost.health.list(),
    'sources.manifest': async ({ providerId }) => {
      requireId(providerId, 'providerId');
      return core.providerHost.manifest(providerId) ?? null;
    },
    'sources.setEnabled': async ({ providerId, enabled }) => {
      requireId(providerId, 'providerId');
      if (!core.providerHost.manifest(providerId)) throw new NotFoundError(`unknown provider ${providerId}`);
      await core.providerHost.setEnabled(providerId, enabled === true);
      if (!enabled) core.state.removeProvider(providerId);
      const current = core.settings.get();
      await core.settings.patch({ providers: { ...current.providers, [providerId]: { enabled: enabled === true } } });
    },
    'sources.refresh': async ({ providerId }) => {
      requireId(providerId, 'providerId');
      if (!core.providerHost.manifest(providerId)) throw new NotFoundError(`unknown provider ${providerId}`);
      await core.providerHost.pollNow(providerId);
      core.state.flush();
    },
    'sources.connection': async () => core.connectionSnapshot(),
    'sources.settings.get': async ({ providerId }) => {
      requireId(providerId, 'providerId');
      return core.providerSettings.get(providerId);
    },
    'sources.settings.set': async ({ providerId, settings }) => {
      requireId(providerId, 'providerId');
      // Deliberately not restricted to registered providers: settings belong to the
      // provider *id*, not to a live instance. They are written before a provider loads,
      // survive a composition that does not include it, and are read when it returns —
      // which is what makes them persist across a restart.
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
        throw new InvalidRequestError('settings must be an object');
      await core.providerSettings.set(providerId, settings as Record<string, JsonValue>);
    },

    // ---- credentials (never readable through IPC) -----------------------------
    'credentials.has': async ({ key }) => {
      requireId(key, 'key');
      return { present: await core.credentials.has(key) };
    },
    'credentials.set': async ({ key, value }) => {
      requireId(key, 'key');
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096)
        throw new InvalidRequestError('credential value must be a non-empty string');
      await core.credentials.set(key, value);
    },
    'credentials.delete': async ({ key }) => {
      requireId(key, 'key');
      await core.credentials.delete(key);
    },

    // ---- history and timeline -------------------------------------------------
    'history.query': async (request) => {
      const query = parseQuery(request);
      return core.history.queryObjects(query);
    },
    'history.availability': async ({ objectTypes }) => {
      const list = await core.history.availability(objectTypes && objectTypes.length ? objectTypes : undefined);
      return list.map((a) => ({ objectType: a.objectType, ranges: a.ranges.map((r) => ({ ...r })) }));
    },
    'history.usage': async () => core.history.usage(),
    'timeline.get': async () => core.timeline.state(),
    'timeline.set': async (update) => {
      if (typeof update !== 'object' || update === null)
        throw new InvalidRequestError('timeline update must be an object');
      const before = core.timeline.currentMode;
      let state: TimelineState;
      try {
        state = core.timeline.set(update);
      } catch (err) {
        throw new InvalidRequestError(errorText(err));
      }
      if (before !== 'LIVE' && state.mode === 'LIVE') core.resetProjection();
      else if (state.mode !== 'LIVE' && state.mode !== 'PAUSED') await core.projectHistorical();
      await core.timeline.refreshAvailability().catch(() => undefined);
      return core.timeline.state();
    },

    // ---- search and lenses ----------------------------------------------------
    'search.query': async ({ text, bias, limit }) => {
      if (typeof text !== 'string') throw new InvalidRequestError('search text must be a string');
      const trimmed = text.trim();
      if (!trimmed) return [];
      const resolvedBias = bias ?? core.defaultBias();
      const results = searchWorld(trimmed.slice(0, 500), {
        state: core.state,
        gazetteer: core.gazetteer,
        events: core.events.store,
        now: () => core.clock.now(),
        limit: clampLimit(limit, 20, 100),
        ...(resolvedBias ? { bias: resolvedBias } : {}),
      });
      // Worldpack place hits that the gazetteer merged keep their 'worldpack' source label.
      return mergePackResults(core, trimmed, results, clampLimit(limit, 20, 100));
    },
    'lenses.list': async () => core.allLenses(),
    'lenses.save': async (lens) => {
      const parsed = requireLens(lens);
      if (parsed.builtIn) throw new InvalidRequestError('built-in lenses cannot be overwritten');
      await core.lenses.save(parsed);
      const all = await core.allLenses();
      core.emitter.emit('lenses.changed', all);
      return all;
    },
    'lenses.delete': async ({ id }) => {
      requireId(id, 'id');
      if ((await core.allLenses()).some((l) => l.id === id && l.builtIn))
        throw new InvalidRequestError('built-in lenses cannot be deleted');
      await core.lenses.remove(id);
      const all = await core.allLenses();
      core.emitter.emit('lenses.changed', all);
      return all;
    },

    // ---- collections ----------------------------------------------------------
    'collections.list': async () => core.collections.list(),
    'collections.save': async (collection) => core.collections.save(requireCollection(collection)),
    'collections.delete': async ({ id }) => {
      requireId(id, 'id');
      return core.collections.remove(id);
    },
    'collections.export': async ({ id }) => {
      requireId(id, 'id');
      const collection = await core.collections.get(id);
      if (!collection) throw new NotFoundError(`unknown collection ${id}`);
      const choice = await core.hostBridge.pickSaveFile({
        title: 'Export collection',
        defaultPath: suggestedPath(core, `${slug(collection.name)}.worldview-collection.json`),
        filters: [{ name: 'WorldView collection', extensions: ['json'] }],
      });
      if ('cancelled' in choice) return { cancelled: true };
      await fs.writeFile(choice.path, `${JSON.stringify({ version: 1, collection }, null, 2)}\n`, 'utf8');
      return { path: choice.path };
    },
    'collections.import': async () => {
      const choice = await core.hostBridge.pickOpenFile({
        title: 'Import collection',
        filters: [{ name: 'WorldView collection', extensions: ['json'] }],
      });
      if ('cancelled' in choice) return { imported: null, issues: ['cancelled'] };
      let raw: string;
      try {
        raw = await fs.readFile(choice.path, 'utf8');
      } catch (err) {
        return { imported: null, issues: [`file is not readable: ${errorText(err)}`] };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return { imported: null, issues: ['file is not valid JSON'] };
      }
      const envelope = parsed as { collection?: unknown };
      const collection = validateCollection(envelope?.collection ?? parsed);
      if (!collection) return { imported: null, issues: ['file does not contain a valid collection'] };
      await core.collections.save(collection);
      return { imported: collection, issues: [] };
    },

    // ---- watch zones ----------------------------------------------------------
    'watchzones.list': async () => core.watchZoneStore.list(),
    'watchzones.save': async (zone) => {
      const parsed = requireWatchZone(zone);
      const zones = await core.watchZoneStore.save(parsed);
      core.watchZones.setZones(zones);
      return zones;
    },
    'watchzones.delete': async ({ id }) => {
      requireId(id, 'id');
      const zones = await core.watchZoneStore.remove(id);
      core.watchZones.setZones(zones);
      return zones;
    },

    // ---- feed ------------------------------------------------------------------
    'feed.recent': async ({ limit, minimumSeverity } = {}) =>
      core.feedItems(clampLimit(limit, 50, 500), minimumSeverity),

    // ---- offline ---------------------------------------------------------------
    'offline.status': async () => core.offlineStatus(),
    'offline.installPack': async () => {
      const choice = await core.hostBridge.pickOpenFile({
        title: 'Install world pack',
        filters: [{ name: 'WorldView pack', extensions: ['worldpack'] }],
      });
      if ('cancelled' in choice) return { installed: null, issues: ['cancelled'] };
      const result = await core.packs.install(choice.path);
      core.emitter.emit('offline.changed', core.offlineStatus());
      return { installed: result.installed, issues: result.issues };
    },
    'offline.removePack': async ({ id }) => {
      requireId(id, 'id');
      await core.packs.remove(id);
      const status = core.offlineStatus();
      core.emitter.emit('offline.changed', status);
      return status;
    },
    'offline.setPackEnabled': async ({ id, enabled }) => {
      requireId(id, 'id');
      await core.packs.setEnabled(id, enabled === true);
      const status = core.offlineStatus();
      core.emitter.emit('offline.changed', status);
      return status;
    },

    // ---- export ----------------------------------------------------------------
    'export.objects': async (request) => exportObjects(core, request),

    // ---- cameras ----------------------------------------------------------------
    'camera.register': async (source) => {
      if (typeof source?.url !== 'string' || typeof source.name !== 'string')
        throw new InvalidRequestError('camera needs a name and a url');
      // RTSP is only reachable through the optional sidecar; start it before the hub
      // routes, so a configured binary that fails to start is reported as such rather
      // than the registration appearing to succeed against a dead gateway.
      if (/^rtsps?:/i.test(source.url)) await core.ensureGo2rtc();
      const registration = await core.cameras.register(source);
      await core.persistCameras();
      return registration;
    },
    'camera.snapshot': async ({ cameraId }) => {
      requireId(cameraId, 'cameraId');
      return core.cameras.snapshot(cameraId);
    },
    'camera.stream': async ({ cameraId }) => {
      requireId(cameraId, 'cameraId');
      await core.ensureCameraRelay();
      if (core.go2rtc.configured() && !core.go2rtc.isRunning()) await core.ensureGo2rtc();
      return core.cameras.stream(cameraId);
    },
    'camera.unregister': async ({ cameraId }) => {
      requireId(cameraId, 'cameraId');
      await core.cameras.unregister(cameraId);
      await core.persistCameras();
    },
    'camera.list': async () =>
      (await core.cameras.list()).map((c) => ({
        cameraId: c.cameraId,
        name: c.name,
        objectId: c.objectId,
        gateway: c.gateway,
      })),

    // ---- diagnostics -------------------------------------------------------------
    'diagnostics.get': async () => core.diagnostics.snapshot(),
    'diagnostics.export': async (_request, ctx) => {
      const stamp = new Date(core.clock.now()).toISOString().replace(/[:.]/g, '-');
      const choice = await core.hostBridge.pickSaveFile({
        title: 'Export diagnostics bundle',
        defaultPath: suggestedPath(core, `worldview-diagnostics-${stamp}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if ('cancelled' in choice) return { cancelled: true };
      const snapshot = (await handlers['diagnostics.get'](undefined, ctx)) as DiagnosticsSnapshot;
      await exportBundle(path.dirname(choice.path), {
        snapshot,
        logFile: core.dirs.logFile,
        fileName: path.basename(choice.path),
        extraRoots: [core.dirs.root],
      });
      return { path: choice.path, redacted: true };
    },

    // ---- updater -------------------------------------------------------------------
    'updater.state': async () => core.updater.state(),
    'updater.check': async () => core.updater.check(),
    'updater.install': async () => core.updater.install(),

    // ---- tile cache --------------------------------------------------------------------
    // The disk tile cache lives in the desktop main process, which overrides these. Anywhere
    // else there is none, and saying so is the whole answer.
    'tiles.status': async () => NO_TILE_CACHE,
    'tiles.clear': async () => NO_TILE_CACHE,
    'tiles.prefetch': async () => undefined,
  };
  return handlers;
}

// ---- helpers ----------------------------------------------------------------------

const NO_TILE_CACHE: TileCacheStatus = Object.freeze({
  available: false,
  bytes: 0,
  tiles: 0,
  maxBytes: 0,
  preload: { state: 'off', done: 0, total: 0 },
}) as TileCacheStatus;

function parseQuery(request: unknown): WorldQuery {
  const parsed = worldQuerySchema.parse(request ?? {});
  if (!parsed.ok) throw new InvalidRequestError(`invalid query: ${formatIssues(parsed.issues)}`);
  return parsed.value;
}

function stripTime(query: WorldQuery): WorldQuery {
  const out: WorldQuery = { ...query };
  delete out.time;
  return out;
}

function parseSubscription(request: unknown): WorldSubscription {
  if (request === undefined || request === null) return {};
  if (typeof request !== 'object' || Array.isArray(request)) throw new InvalidRequestError('invalid subscription');
  const r = request as Record<string, unknown>;
  const out: WorldSubscription = {};
  if (Array.isArray(r['objectTypes']))
    out.objectTypes = r['objectTypes'].filter((v): v is string => typeof v === 'string').slice(0, 64);
  if (r['bounds'] !== undefined) {
    if (!isBounds(r['bounds'])) throw new InvalidRequestError('invalid subscription bounds');
    out.bounds = r['bounds'];
  }
  if (Array.isArray(r['pinnedIds']))
    out.pinnedIds = r['pinnedIds'].filter((v): v is string => typeof v === 'string').slice(0, 500);
  return out;
}

function isBounds(value: unknown): value is GeoBounds {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return ['west', 'south', 'east', 'north'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k] as number));
}

function requireId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512)
    throw new InvalidRequestError(`${field} must be a non-empty string`);
}

function requireRange(range: unknown): asserts range is TimeRange {
  const r = range as Partial<TimeRange> | undefined;
  const start = r?.start ? Date.parse(r.start) : NaN;
  const end = r?.end ? Date.parse(r.end) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new InvalidRequestError('invalid time range');
}

function within(range: TimeRange, iso: string): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(range.start) && t <= Date.parse(range.end);
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * The composite gazetteer already merges worldpack places into the parser's results; this
 * adds direct pack hits for queries the grammar did not turn into a place intent, so an
 * offline session still finds everything in its installed packs.
 */
function mergePackResults(core: RuntimeCore, text: string, results: SearchResult[], limit: number): SearchResult[] {
  const index = core.packs.placeIndex();
  if (index.size === 0) return results.slice(0, limit);
  const byId = new Map(results.map((r) => [r.id, r] as const));
  for (const hit of index.search(text, { limit })) {
    const result = placeHitToSearchResult(hit);
    const existing = byId.get(result.id);
    if (!existing || existing.score < result.score) byId.set(result.id, result);
  }
  const out = [...byId.values()];
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, limit);
}

/**
 * `app.openExternal` is an allowlist, not a pass-through: https only, no embedded
 * credentials, and the host must come from a registered provider's attribution / terms /
 * credential-help links (or the static project set). Anything else is DENIED.
 */
function externalUrl(url: unknown, allowed: ReadonlySet<string>): string {
  if (typeof url !== 'string' || url.length > 2048)
    throw new InvalidRequestError('url must be a string of at most 2048 characters');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRequestError('url is not valid');
  }
  if (parsed.protocol !== 'https:') throw new InvalidRequestError('only https links can be opened externally');
  if (parsed.username || parsed.password) throw new InvalidRequestError('url must not carry credentials');
  const host = parsed.hostname.toLowerCase();
  if (!allowed.has(host)) throw new DeniedError(`${host} is not an allowed external host`);
  return parsed.toString();
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'collection'
  );
}

function suggestedPath(core: RuntimeCore, fileName: string): string {
  const downloads = core.hostBridge.appPaths().downloads;
  return downloads ? path.join(downloads, fileName) : fileName;
}

// ---- export.objects ----------------------------------------------------------------

async function exportObjects(
  core: RuntimeCore,
  request: { query: WorldQuery; format: 'geojson' | 'json' | 'csv' },
): Promise<{ path: string; skippedProviders: string[] } | { cancelled: true }> {
  const format = request?.format;
  if (format !== 'geojson' && format !== 'json' && format !== 'csv')
    throw new InvalidRequestError('format must be geojson, json or csv');
  const query = parseQuery(request?.query);

  const result: WorldQueryResult<WorldObject> = core.isLive()
    ? query.time
      ? await executeQueryWithHistory(query, {
          state: core.state,
          history: core.historyReader,
          now: () => core.clock.now(),
        })
      : executeQuery(query, { state: core.state, now: () => core.clock.now() })
    : applyObjectQuery(await core.activeObjects(), stripTime(query), 'historical', core.clock.now());

  // Policy gate: an object is exportable only when every provider that supports it allows export.
  const skipped = new Set<string>();
  const allowed: WorldObject[] = [];
  for (const object of result.items.slice(0, MAX_EXPORT_ROWS)) {
    const providers = new Set(object.sourceRefs.map((r) => r.providerId));
    let ok = true;
    for (const providerId of providers) {
      const policy = core.policyFor(providerId);
      if (!policy || !mayExport(policy)) {
        skipped.add(providerId);
        ok = false;
      }
    }
    if (ok) allowed.push(object);
  }

  const choice = await core.hostBridge.pickSaveFile({
    title: 'Export objects',
    defaultPath: suggestedPath(
      core,
      `worldview-export-${new Date(core.clock.now()).toISOString().slice(0, 10)}.${format === 'geojson' ? 'geojson' : format}`,
    ),
    filters: [{ name: format.toUpperCase(), extensions: [format === 'geojson' ? 'geojson' : format] }],
  });
  if ('cancelled' in choice) return { cancelled: true };

  const attribution = [...new Set(allowed.map((o) => o.provenance.attribution).filter((a): a is string => Boolean(a)))];
  const body =
    format === 'csv'
      ? toCsv(allowed)
      : format === 'geojson'
        ? toGeoJson(allowed, attribution)
        : JSON.stringify(
            { exportedAt: new Date(core.clock.now()).toISOString(), attribution, objects: allowed },
            null,
            2,
          );
  await fs.writeFile(choice.path, `${body}\n`, 'utf8');
  core.log.info('objects exported', { format, objects: allowed.length, skippedProviders: skipped.size });
  return { path: choice.path, skippedProviders: [...skipped].sort() };
}

function toGeoJson(objects: readonly WorldObject[], attribution: string[]): string {
  const features = objects.map((o) => ({
    type: 'Feature' as const,
    id: o.id,
    geometry:
      o.geometry ??
      (o.position ? { type: 'Point' as const, coordinates: [o.position.longitude, o.position.latitude] } : null),
    properties: {
      id: o.id,
      type: o.type,
      observedAt: o.observedAt,
      freshness: o.freshness,
      confidence: o.confidence,
      ...o.labels,
      ...o.properties,
      provider: o.provenance.providerId,
      source: o.provenance.sourceName,
      origin: o.provenance.origin,
      ...(o.provenance.attribution ? { attribution: o.provenance.attribution } : {}),
    },
  }));
  return JSON.stringify(
    { type: 'FeatureCollection', features, ...(attribution.length ? { attribution } : {}) },
    null,
    2,
  );
}

const CSV_COLUMNS = [
  'id',
  'type',
  'observedAt',
  'updatedAt',
  'freshness',
  'confidence',
  'latitude',
  'longitude',
  'altitudeM',
  'label',
  'provider',
  'source',
  'origin',
  'attribution',
] as const;

function toCsv(objects: readonly WorldObject[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const o of objects) {
    rows.push(CSV_COLUMNS.map((column) => csvCell(csvValue(o, column))).join(','));
  }
  return rows.join('\n');
}

function csvValue(o: WorldObject, column: (typeof CSV_COLUMNS)[number]): string | number | undefined {
  switch (column) {
    case 'id':
      return o.id;
    case 'type':
      return o.type;
    case 'observedAt':
      return o.observedAt;
    case 'updatedAt':
      return o.updatedAt;
    case 'freshness':
      return o.freshness;
    case 'confidence':
      return o.confidence;
    case 'latitude':
      return o.position?.latitude;
    case 'longitude':
      return o.position?.longitude;
    case 'altitudeM':
      return o.position?.altitudeM;
    case 'label':
      return o.labels['name'] ?? o.labels['callsign'] ?? o.labels['title'] ?? o.labels['place'];
    case 'provider':
      return o.provenance.providerId;
    case 'source':
      return o.provenance.sourceName;
    case 'origin':
      return o.provenance.origin;
    case 'attribution':
      return o.provenance.attribution;
  }
}

/** CSV cells are quoted and a leading =/+/-/@ is prefixed so a spreadsheet never executes a cell. */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
