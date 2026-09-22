import type { JsonValue, Observation, WorldEvent, WorldObject } from '@worldview/world-model';
import { WorldState } from '@worldview/state-engine';
import type { RuleContext } from './rules/types.js';
import type { EventStore } from './store.js';

/** Synthetic fixtures for event-engine tests. No live data. */
export const T0 = Date.parse('2026-09-21T12:00:00.000Z');
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

export class FixedClock {
  constructor(private t = T0) {}
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface ObjSpec {
  id: string;
  type: string;
  providerId?: string;
  observedAt?: string;
  lat?: number;
  lon?: number;
  altitudeM?: number;
  properties?: Record<string, JsonValue>;
  labels?: Record<string, string>;
  origin?: WorldObject['provenance']['origin'];
  validUntil?: string;
  confidence?: number;
  geometry?: WorldObject['geometry'];
}

export function obj(spec: ObjSpec): WorldObject {
  const observedAt = spec.observedAt ?? iso(0);
  const providerId = spec.providerId ?? 'test-provider';
  const value = spec.id.slice(spec.id.lastIndexOf(':') + 1);
  const o: WorldObject = {
    id: spec.id,
    type: spec.type,
    sourceRefs: [{ observationId: `${providerId}:${value}:${observedAt}`, providerId, observedAt }],
    observedAt,
    updatedAt: observedAt,
    freshness: 'LIVE',
    confidence: spec.confidence ?? 0.9,
    labels: { ...(spec.labels ?? {}) },
    properties: { ...(spec.properties ?? {}) },
    provenance: { providerId, sourceName: providerId, origin: spec.origin ?? 'live', receivedAt: observedAt },
  };
  if (spec.lat !== undefined && spec.lon !== undefined)
    o.position = {
      latitude: spec.lat,
      longitude: spec.lon,
      ...(spec.altitudeM !== undefined ? { altitudeM: spec.altitudeM } : {}),
    };
  if (spec.validUntil) o.validUntil = spec.validUntil;
  if (spec.geometry) o.geometry = spec.geometry;
  return o;
}

export function quake(
  id: string,
  mag: number,
  lat: number,
  lon: number,
  observedAt: string,
  extra: Record<string, JsonValue> = {},
): WorldObject {
  return obj({
    id: `earthquake:usgs:${id}`,
    type: 'earthquake',
    providerId: 'usgs-earthquakes',
    observedAt,
    lat,
    lon,
    properties: { magnitude: mag, depthKm: 10, place: `Test place ${id}`, ...extra },
  });
}

export function fire(id: string, lat: number, lon: number, observedAt: string, frp?: number): WorldObject {
  return obj({
    id: `fire-detection:nasa-firms:${id}`,
    type: 'fire-detection',
    providerId: 'nasa-firms',
    observedAt,
    lat,
    lon,
    properties: frp !== undefined ? { frpMw: frp } : {},
  });
}

export function observationOf(o: WorldObject): Observation {
  const ref = o.sourceRefs[0]!;
  const obs: Observation = {
    id: ref.observationId,
    providerId: ref.providerId,
    externalId: o.id.slice(o.id.lastIndexOf(':') + 1),
    objectType: o.type,
    observedAt: o.observedAt,
    receivedAt: o.observedAt,
    payload: { ...o.properties, ...o.labels },
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: o.provenance,
  };
  if (o.position) obs.position = o.position;
  if (o.geometry) obs.geometry = o.geometry;
  if (o.validUntil) obs.effectiveUntil = o.validUntil;
  return obs;
}

/** A manual-flush WorldState seeded from objects (each ingested as its own provider batch). */
export function stateOf(clock: { now(): number }, objects: WorldObject[]): WorldState {
  const state = new WorldState({ clock, flushDelayMs: 0 });
  const byProvider = new Map<string, Observation[]>();
  for (const o of objects) {
    const obs = observationOf(o);
    const list = byProvider.get(obs.providerId) ?? [];
    list.push(obs);
    byProvider.set(obs.providerId, list);
  }
  for (const [providerId, observations] of byProvider) state.ingest(observations, { snapshot: false, providerId });
  state.flush();
  return state;
}

export function ctxAt(nowMs: number, store?: EventStore): RuleContext {
  return { now: nowMs, nowIso: new Date(nowMs).toISOString(), existing: (type) => store?.ofType(type) ?? [] };
}

export function eventFrom(partial: Partial<WorldEvent> & { id: string; type: string; startAt: string }): WorldEvent {
  return {
    title: partial.id,
    objectIds: [],
    observationRefs: [],
    confidence: 'HIGH',
    summary: '',
    provenance: { providerId: 'worldview', sourceName: 'test', origin: 'derived', receivedAt: partial.startAt },
    ...partial,
  };
}
