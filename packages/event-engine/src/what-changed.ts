import { EventTypes, regionBounds, regionContains, type GeoRegion, type TimeRange, type WorldEvent, type WorldObject } from '@worldview/world-model';
import type { WorldState } from '@worldview/state-engine';
import type { WhatChangedResult } from '@worldview/ipc-contract';
import { geometryIntersectsRegion, type EventSource, type HistoryReader } from '@worldview/query-engine';
import { compareEvents } from './store.js';

/**
 * whatChanged — "what happened here since …" for a region and time range.
 *
 *   newEvents      events whose startAt falls in the range and whose geometry intersects the region
 *   endedEvents    events whose endAt falls in the range (same spatial test)
 *   statusChanges  with history: objects whose status (properties.status | labels.status) differs between
 *                  the snapshot at range.start and the state at range.end; without history: provider
 *                  status transitions (source-status-change events) in the range
 *   countChanges   per object type: before = objects known at range.start (history snapshot, or live
 *                  objects observed before start and still valid then) · after = objects at range.end
 *   newAlerts      the weather-alert subset of newEvents
 */
export interface WhatChangedSources {
  events: EventSource;
  state: WorldState;
  history?: HistoryReader;
  now(): number;
}

/** When range.end is older than this, and history is available, "after" is read from history instead of live state. */
const LIVE_TOLERANCE_MS = 5 * 60_000;

export async function whatChanged(input: { region: GeoRegion; time: TimeRange }, sources: WhatChangedSources): Promise<WhatChangedResult> {
  const { region, time } = input;
  const start = Date.parse(time.start), end = Date.parse(time.end);
  const now = sources.now();
  const inRange = (iso: string | undefined) => { if (!iso) return false; const t = Date.parse(iso); return t >= start && t <= end; };
  const inRegion = (e: WorldEvent) => e.geometry !== undefined && geometryIntersectsRegion(e.geometry, region);

  const newEvents: WorldEvent[] = [];
  const endedEvents: WorldEvent[] = [];
  const statusEvents: WorldEvent[] = [];
  for (const e of sources.events.all()) {
    if (e.type === EventTypes.SourceStatusChange) { if (inRange(e.startAt)) statusEvents.push(e); continue; }
    if (!inRegion(e)) continue;
    if (inRange(e.startAt)) newEvents.push(e);
    if (inRange(e.endAt)) endedEvents.push(e);
  }
  newEvents.sort(compareEvents);
  endedEvents.sort(compareEvents);

  const bounds = regionBounds(region);
  const before: WorldObject[] | undefined = sources.history && bounds
    ? (await sources.history.objectsAt(time.start, { bounds })).filter((o) => o.position && regionContains(region, o.position))
    : undefined;
  const useHistoryAfter = sources.history !== undefined && bounds !== undefined && now - end > LIVE_TOLERANCE_MS;
  const after: WorldObject[] = useHistoryAfter
    ? (await sources.history!.objectsAt(time.end, { bounds: bounds! })).filter((o) => o.position && regionContains(region, o.position))
    : liveInRegion(sources.state, region);

  const statusChanges: WhatChangedResult['statusChanges'] = [];
  if (before) {
    const afterById = new Map(after.map((o) => [o.id, o]));
    for (const prev of before) {
      const next = afterById.get(prev.id);
      if (!next) continue;
      const from = statusOf(prev), to = statusOf(next);
      if (from !== undefined && to !== undefined && from !== to) statusChanges.push({ objectId: prev.id, from, to, at: next.observedAt });
    }
    statusChanges.sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
  } else {
    for (const e of statusEvents.sort(compareEvents)) {
      const p = e.properties ?? {};
      const providerId = typeof p['providerId'] === 'string' ? p['providerId'] : e.id;
      statusChanges.push({ objectId: `source:${providerId}`, from: String(p['from'] ?? ''), to: String(p['to'] ?? ''), at: e.startAt });
    }
  }

  const beforeCounts = before ? countByType(before) : countByType(liveInRegion(sources.state, region).filter((o) => knownAt(o, start)));
  const afterCounts = countByType(after);
  const types = [...new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)])].sort();
  const countChanges: WhatChangedResult['countChanges'] = [];
  for (const t of types) {
    const b = beforeCounts[t] ?? 0, a = afterCounts[t] ?? 0;
    if (b !== a) countChanges.push({ objectType: t, before: b, after: a });
  }

  return { region, time, newEvents, endedEvents, statusChanges, countChanges, newAlerts: newEvents.filter((e) => e.type === EventTypes.WeatherAlert) };
}

function liveInRegion(state: WorldState, region: GeoRegion): WorldObject[] {
  if (region.kind === 'admin' && !region.bounds) return [];
  return state.withinRegion(region);
}

function knownAt(o: WorldObject, atMs: number): boolean {
  const observed = Date.parse(o.observedAt);
  if (!Number.isFinite(observed) || observed >= atMs) return false;
  if (o.validUntil !== undefined) return Date.parse(o.validUntil) > atMs;
  return true;
}

function statusOf(o: WorldObject): string | undefined {
  const s = o.properties['status'] ?? o.labels['status'];
  return typeof s === 'string' ? s : undefined;
}

function countByType(objects: readonly WorldObject[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of objects) out[o.type] = (out[o.type] ?? 0) + 1;
  return out;
}
