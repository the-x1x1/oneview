import {
  regionBounds, regionContains, timeRangeContains,
  type GeoBounds, type IsoTimestamp, type SortDefinition, type WorldEvent, type WorldObject, type WorldQuery, type WorldQueryResult,
} from '@worldview/world-model';
import type { WorldState } from '@worldview/state-engine';
import { compareValues, resolveEventField, resolveObjectField, type FieldValue } from './fields.js';
import { matchesAll } from './filters.js';
import { geometryIntersectsRegion } from './geometry.js';
import { eventSearchStrings, matchesTokens, objectSearchStrings, tokenize } from './text-match.js';

/**
 * Query execution (ADR-010: deterministic, no LLM). The pipeline is the same for live
 * and historical evaluation:
 *
 *   candidates (state spatial query | history snapshot | event store)
 *     → objectTypes / eventTypes → providerIds → region (exact) → time → filters → text
 *     → sort (type-aware, id tie-break) → limit (truncated flag)
 */

/** Narrow read interface over the history store, so tests can stub it and the runtime can adapt `HistoryStore.snapshotAt`. */
export interface HistoryReader {
  objectsAt(cursor: IsoTimestamp, opts: HistoryReadOptions): Promise<WorldObject[]> | WorldObject[];
}

export interface HistoryReadOptions {
  objectTypes?: string[];
  providerIds?: string[];
  bounds?: GeoBounds;
  /** Only observations newer than cursor − lookback are candidates. */
  lookbackSeconds?: number;
}

/** Narrow read interface over an event store (implemented by @worldview/event-engine EventStore). */
export interface EventSource {
  all(): Iterable<WorldEvent>;
}

export interface QuerySources {
  state: WorldState;
  history?: HistoryReader;
  now(): number;
}

export interface EventQuerySources {
  events: EventSource;
  now(): number;
}

/** Live evaluation. `query.time` without a history reader filters live objects by observedAt (basis stays 'live'). */
export function executeQuery(query: WorldQuery, sources: Pick<QuerySources, 'state' | 'now'>): WorldQueryResult<WorldObject> {
  const candidates = liveCandidates(query, sources.state);
  return applyObjectQuery(candidates, query, 'live', sources.now());
}

/** Historical evaluation when `query.time` is set and a history reader is available; otherwise identical to executeQuery. */
export async function executeQueryWithHistory(query: WorldQuery, sources: QuerySources): Promise<WorldQueryResult<WorldObject>> {
  if (!query.time || !sources.history) return executeQuery(query, sources);
  const bounds = query.region ? regionBounds(query.region) : undefined;
  const lookback = Math.max(0, (Date.parse(query.time.end) - Date.parse(query.time.start)) / 1000);
  const opts: HistoryReadOptions = {
    ...(query.objectTypes ? { objectTypes: query.objectTypes } : {}),
    ...(query.providerIds ? { providerIds: query.providerIds } : {}),
    ...(bounds ? { bounds } : {}),
    ...(lookback > 0 ? { lookbackSeconds: lookback } : {}),
  };
  const rows = await sources.history.objectsAt(query.time.end, opts);
  // History already bounded the time window through the lookback; do not re-apply observedAt ≥ start
  // to a snapshot (a still-valid object observed before the window is part of the state at time.end).
  const withoutTime: WorldQuery = { ...query };
  delete withoutTime.time;
  return applyObjectQuery(rows, withoutTime, 'historical', sources.now());
}

export function executeEventQuery(query: WorldQuery, sources: EventQuerySources): WorldQueryResult<WorldEvent> {
  const tokens = query.text ? tokenize(query.text) : [];
  const typeSet = query.eventTypes && query.eventTypes.length ? new Set(query.eventTypes) : undefined;
  const providerSet = query.providerIds && query.providerIds.length ? new Set(query.providerIds) : undefined;
  const region = query.region;
  const time = query.time;
  const matched: WorldEvent[] = [];
  for (const e of sources.events.all()) {
    if (typeSet && !typeSet.has(e.type)) continue;
    if (providerSet && !providerSet.has(e.provenance.providerId)) continue;
    if (region && !(e.geometry && geometryIntersectsRegion(e.geometry, region))) continue;
    if (time && !eventOverlapsRange(e, time.start, time.end)) continue;
    if (!matchesAll((p) => resolveEventField(e, p), query.filters)) continue;
    if (tokens.length && !matchesTokens(eventSearchStrings(e), tokens)) continue;
    matched.push(e);
  }
  const sorted = sortItems(matched, query.sort, (e, p) => resolveEventField(e, p), (e) => e.id, (e) => e.startAt);
  return finish(sorted, query.limit, 'live', sources.now());
}

/** The pure core: filter/sort/limit an explicit candidate list. Exported for callers that already hold objects. */
export function applyObjectQuery(candidates: Iterable<WorldObject>, query: WorldQuery, basis: 'live' | 'historical', nowMs: number): WorldQueryResult<WorldObject> {
  const tokens = query.text ? tokenize(query.text) : [];
  const typeSet = query.objectTypes && query.objectTypes.length ? new Set(query.objectTypes) : undefined;
  const providerSet = query.providerIds && query.providerIds.length ? new Set(query.providerIds) : undefined;
  const region = query.region;
  const time = query.time;
  const matched: WorldObject[] = [];
  for (const o of candidates) {
    if (typeSet && !typeSet.has(o.type)) continue;
    if (providerSet && !objectFromProviders(o, providerSet)) continue;
    if (region && !(o.position && regionContains(region, o.position))) continue;
    if (time && !timeRangeContains(time, o.observedAt)) continue;
    if (!matchesAll((p) => resolveObjectField(o, p), query.filters)) continue;
    if (tokens.length && !matchesTokens(objectSearchStrings(o), tokens)) continue;
    matched.push(o);
  }
  const sorted = sortItems(matched, query.sort, (o, p) => resolveObjectField(o, p), (o) => o.id, (o) => o.observedAt);
  return finish(sorted, query.limit, basis, nowMs);
}

function liveCandidates(query: WorldQuery, state: WorldState): Iterable<WorldObject> {
  const types = query.objectTypes && query.objectTypes.length ? query.objectTypes : undefined;
  if (query.region) {
    if (query.region.kind === 'admin' && !query.region.bounds) return [];
    return state.withinRegion(query.region, types);
  }
  if (types) {
    const out: WorldObject[] = [];
    for (const t of types) out.push(...state.ofType(t));
    return out;
  }
  return state.all();
}

function objectFromProviders(o: WorldObject, providers: ReadonlySet<string>): boolean {
  if (providers.has(o.provenance.providerId)) return true;
  for (const r of o.sourceRefs) if (providers.has(r.providerId)) return true;
  return false;
}

function eventOverlapsRange(e: WorldEvent, start: IsoTimestamp, end: IsoTimestamp): boolean {
  const s = Date.parse(e.startAt);
  const en = e.endAt ? Date.parse(e.endAt) : s;
  const rs = Date.parse(start), re = Date.parse(end);
  return s <= re && en >= rs;
}

function sortItems<T>(items: T[], sort: SortDefinition | undefined, resolve: (item: T, path: string) => FieldValue, idOf: (item: T) => string, timeOf: (item: T) => string): T[] {
  const dir = sort?.direction === 'asc' ? 1 : -1;
  const keyed = items.map((item) => ({ item, key: sort ? resolve(item, sort.field) : timeOf(item), id: idOf(item) }));
  keyed.sort((a, b) => {
    const ka = a.key, kb = b.key;
    const aNone = ka === undefined || ka === null, bNone = kb === undefined || kb === null;
    if (aNone && !bNone) return 1;
    if (bNone && !aNone) return -1;
    const c = aNone && bNone ? 0 : compareValues(ka, kb) * dir;
    if (c !== 0) return c;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return keyed.map((k) => k.item);
}

function finish<T>(sorted: T[], limit: number | undefined, basis: 'live' | 'historical', nowMs: number): WorldQueryResult<T> {
  const total = sorted.length;
  const items = limit !== undefined && limit >= 0 && limit < total ? sorted.slice(0, limit) : sorted;
  return { items, total, truncated: items.length < total, basis, evaluatedAt: new Date(nowMs).toISOString() };
}
