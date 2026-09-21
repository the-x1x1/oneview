import type { JsonValue, Observation, WorldEvent, WorldObject } from '@worldview/world-model';
import { WorldState } from '@worldview/state-engine';

/**
 * Shared synthetic fixtures for engine tests (no live data). Everything is built from
 * explicit values so tests are deterministic and fast.
 */
export const T0 = Date.parse('2026-09-21T12:00:00.000Z');

export class FixedClock {
  constructor(private t = T0) {}
  now(): number { return this.t; }
  set(ms: number): void { this.t = ms; }
  advance(ms: number): void { this.t += ms; }
}

export interface ObsSpec {
  providerId: string;
  objectType: string;
  externalId: string;
  observedAt?: string;
  lat?: number;
  lon?: number;
  altitudeM?: number;
  payload?: Record<string, JsonValue>;
  origin?: Observation['provenance']['origin'];
  effectiveUntil?: string;
  geometry?: Observation['geometry'];
}

export function obs(spec: ObsSpec): Observation {
  const observedAt = spec.observedAt ?? new Date(T0).toISOString();
  const o: Observation = {
    id: `${spec.providerId}:${spec.externalId}:${observedAt}`,
    providerId: spec.providerId,
    externalId: spec.externalId,
    objectType: spec.objectType,
    observedAt,
    receivedAt: observedAt,
    payload: spec.payload ?? {},
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: { providerId: spec.providerId, sourceName: spec.providerId, origin: spec.origin ?? 'live', receivedAt: observedAt },
  };
  if (spec.lat !== undefined && spec.lon !== undefined) o.position = { latitude: spec.lat, longitude: spec.lon, ...(spec.altitudeM !== undefined ? { altitudeM: spec.altitudeM } : {}) };
  if (spec.effectiveUntil) o.effectiveUntil = spec.effectiveUntil;
  if (spec.geometry) o.geometry = spec.geometry;
  return o;
}

/** Ingest observations grouped by provider into a manual-flush WorldState. */
export function stateWith(clock: { now(): number }, specs: ObsSpec[]): WorldState {
  const state = new WorldState({ clock, flushDelayMs: 0 });
  const byProvider = new Map<string, Observation[]>();
  for (const s of specs) {
    const o = obs(s);
    const list = byProvider.get(o.providerId) ?? [];
    list.push(o);
    byProvider.set(o.providerId, list);
  }
  for (const [providerId, observations] of byProvider) state.ingest(observations, { snapshot: false, providerId });
  state.flush();
  return state;
}

export function objectFrom(spec: ObsSpec & { id?: string; freshness?: WorldObject['freshness']; confidence?: number }): WorldObject {
  const o = obs(spec);
  const obj: WorldObject = {
    id: spec.id ?? `${spec.objectType}:${spec.providerId}:${spec.externalId}`,
    type: o.objectType,
    sourceRefs: [{ observationId: o.id, providerId: o.providerId, observedAt: o.observedAt }],
    observedAt: o.observedAt,
    updatedAt: o.observedAt,
    freshness: spec.freshness ?? 'LIVE',
    confidence: spec.confidence ?? 0.9,
    labels: {},
    properties: { ...o.payload },
    provenance: o.provenance,
  };
  for (const k of ['name', 'callsign', 'title', 'place', 'registration']) {
    const v = o.payload[k];
    if (typeof v === 'string') obj.labels[k] = v;
  }
  if (o.position) obj.position = o.position;
  if (o.geometry) obj.geometry = o.geometry;
  if (spec.effectiveUntil) obj.validUntil = spec.effectiveUntil;
  const speed = o.payload['speedMps'];
  if (typeof speed === 'number') obj.motion = { speedMps: speed };
  return obj;
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
