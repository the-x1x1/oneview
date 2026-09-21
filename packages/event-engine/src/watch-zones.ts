import { EventTypes, ObjectTypes, classifyConfidence, positionToGeometry, regionContains, systemClock, type Clock, type JsonValue, type SeverityClass, type WorldEvent, type WorldObject } from '@worldview/world-model';
import type { WatchZone, WorldEvents } from '@worldview/ipc-contract';
import { geometryIntersectsRegion } from '@worldview/query-engine';
import { TypedEmitter } from '@worldview/core';
import { severityAtLeast } from './severity.js';
import { ENGINE_PROVIDER_ID, ENGINE_SOURCE_NAME } from './rules/types.js';

/**
 * WatchZoneEvaluator — emits one `watch-zone-entry` event per (zone, subject) when an
 * event's geometry intersects the zone and its severity meets the zone's minimum, or
 * when an aircraft/vessel enters a zone that subscribes to 'watch-zone-entry'.
 * A 6 h dedupe window suppresses repeats for the same (zone, subject).
 */
export type NotificationPayload = WorldEvents['notification'];

export interface WatchZoneHit {
  zone: WatchZone;
  subjectKind: 'event' | 'object';
  subjectId: string;
  event: WorldEvent;
  notification: NotificationPayload;
}

export interface WatchZoneEvaluatorOptions {
  clock?: Clock;
  /** Default 6 h. */
  dedupeWindowMs?: number;
  /** Object types that trigger entry events (default aircraft, vessel). */
  entryObjectTypes?: readonly string[];
}

export const WATCH_ZONE_DEDUPE_MS = 6 * 3_600_000;
const OBJECT_ENTRY_SEVERITY: SeverityClass = 'MINOR';

export class WatchZoneEvaluator {
  private readonly clock: Clock;
  private readonly dedupeMs: number;
  private readonly entryTypes: ReadonlySet<string>;
  private zoneList: WatchZone[] = [];
  private readonly lastEmit = new Map<string, number>();
  private readonly inside = new Set<string>();
  private readonly emitter = new TypedEmitter<{ hit: WatchZoneHit }>();

  constructor(opts: WatchZoneEvaluatorOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.dedupeMs = opts.dedupeWindowMs ?? WATCH_ZONE_DEDUPE_MS;
    this.entryTypes = new Set(opts.entryObjectTypes ?? [ObjectTypes.Aircraft, ObjectTypes.Vessel]);
  }

  on(event: 'hit', listener: (hit: WatchZoneHit) => void): () => void { return this.emitter.on(event, listener); }

  setZones(zones: readonly WatchZone[]): void {
    this.zoneList = [...zones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ids = new Set(this.zoneList.map((z) => z.id));
    for (const key of [...this.lastEmit.keys()]) if (!ids.has(key.slice(0, key.indexOf('|')))) this.lastEmit.delete(key);
    for (const key of [...this.inside]) if (!ids.has(key.slice(0, key.indexOf('|')))) this.inside.delete(key);
  }

  zones(): readonly WatchZone[] { return this.zoneList; }

  /** Evaluate a new or updated event against every enabled zone. */
  evaluateEvent(event: WorldEvent): WatchZoneHit[] {
    if (event.type === EventTypes.WatchZoneEntry || !event.geometry) return [];
    const now = this.clock.now();
    const hits: WatchZoneHit[] = [];
    for (const zone of this.zoneList) {
      if (!zone.enabled || !zoneAccepts(zone, event.type)) continue;
      if (!severityAtLeast(event.severity, zone.minimumSeverity)) continue;
      if (!geometryIntersectsRegion(event.geometry, zone.geometry)) continue;
      if (!this.allow(zone.id, event.id, now)) continue;
      hits.push(this.hit(zone, 'event', event.id, entryFromEvent(zone, event, now)));
    }
    return hits;
  }

  /** Evaluate objects for entry into zones that subscribe to 'watch-zone-entry'. Emits on outside→inside transitions only. */
  evaluateObjects(objects: readonly WorldObject[]): WatchZoneHit[] {
    const now = this.clock.now();
    const hits: WatchZoneHit[] = [];
    const zones = this.zoneList.filter((z) => z.enabled && z.eventTypes.includes(EventTypes.WatchZoneEntry));
    if (zones.length === 0) return hits;
    for (const o of objects) {
      if (!this.entryTypes.has(o.type) || !o.position) continue;
      for (const zone of zones) {
        const key = `${zone.id}|${o.id}`;
        const isInside = regionContains(zone.geometry, o.position);
        const wasInside = this.inside.has(key);
        if (!isInside) { this.inside.delete(key); continue; }
        this.inside.add(key);
        if (wasInside) continue;
        if (!severityAtLeast(OBJECT_ENTRY_SEVERITY, zone.minimumSeverity)) continue;
        if (!this.allow(zone.id, o.id, now)) continue;
        hits.push(this.hit(zone, 'object', o.id, entryFromObject(zone, o, now)));
      }
    }
    return hits;
  }

  /** Forget an object that left the live state so its next appearance counts as an entry. */
  forgetObject(objectId: string): void {
    for (const key of [...this.inside]) if (key.endsWith(`|${objectId}`)) this.inside.delete(key);
  }

  private allow(zoneId: string, subjectId: string, now: number): boolean {
    const key = `${zoneId}|${subjectId}`;
    const last = this.lastEmit.get(key);
    if (last !== undefined && now - last < this.dedupeMs) return false;
    this.lastEmit.set(key, now);
    return true;
  }

  private hit(zone: WatchZone, subjectKind: 'event' | 'object', subjectId: string, event: WorldEvent): WatchZoneHit {
    const notification: NotificationPayload = {
      id: event.id,
      title: event.title,
      body: event.summary,
      severity: event.severity ?? 'INFO',
      eventId: subjectKind === 'event' ? subjectId : event.id,
      watchZoneId: zone.id,
    };
    const hit: WatchZoneHit = { zone, subjectKind, subjectId, event, notification };
    this.emitter.emit('hit', hit);
    return hit;
  }
}

function zoneAccepts(zone: WatchZone, eventType: string): boolean {
  if (zone.eventTypes.length === 0) return true;
  return zone.eventTypes.includes(eventType) || zone.eventTypes.includes('*');
}

function entryId(zone: WatchZone, subjectId: string, now: number): string {
  return `event:${EventTypes.WatchZoneEntry}:${zone.id}:${subjectId}@${Math.floor(now / 1000)}`;
}

function entryFromEvent(zone: WatchZone, subject: WorldEvent, now: number): WorldEvent {
  const nowIso = new Date(now).toISOString();
  const properties: Record<string, JsonValue> = { watchZoneId: zone.id, watchZoneName: zone.name, subjectEventId: subject.id, subjectType: subject.type };
  const e: WorldEvent = {
    id: entryId(zone, subject.id, now),
    type: EventTypes.WatchZoneEntry,
    title: `${zone.name}: ${subject.title}`,
    startAt: nowIso,
    objectIds: [...subject.objectIds],
    observationRefs: [...subject.observationRefs],
    confidence: subject.confidence,
    severity: subject.severity ?? 'INFO',
    summary: `${subject.title} intersects watch zone "${zone.name}".`,
    properties,
    provenance: { providerId: ENGINE_PROVIDER_ID, sourceName: ENGINE_SOURCE_NAME, origin: subject.provenance.origin === 'recorded' ? 'recorded' : 'derived', receivedAt: nowIso, derivedFrom: [...subject.observationRefs] },
  };
  if (subject.geometry) e.geometry = subject.geometry;
  return e;
}

function entryFromObject(zone: WatchZone, o: WorldObject, now: number): WorldEvent {
  const nowIso = new Date(now).toISOString();
  const label = o.labels['callsign'] ?? o.labels['name'] ?? o.labels['registration'] ?? o.id.slice(o.id.lastIndexOf(':') + 1);
  const properties: Record<string, JsonValue> = { watchZoneId: zone.id, watchZoneName: zone.name, subjectObjectId: o.id, subjectType: o.type };
  const e: WorldEvent = {
    id: entryId(zone, o.id, now),
    type: EventTypes.WatchZoneEntry,
    title: `${zone.name}: ${o.type} ${label} entered`,
    startAt: nowIso,
    objectIds: [o.id],
    observationRefs: [...o.sourceRefs],
    confidence: classifyConfidence(o.confidence),
    severity: OBJECT_ENTRY_SEVERITY,
    summary: `${capitalize(o.type)} ${label} entered watch zone "${zone.name}" (observed ${o.observedAt.slice(0, 16).replace('T', ' ')} UTC).`,
    properties,
    provenance: { providerId: ENGINE_PROVIDER_ID, sourceName: ENGINE_SOURCE_NAME, origin: o.provenance.origin === 'recorded' ? 'recorded' : 'derived', receivedAt: nowIso, derivedFrom: [...o.sourceRefs] },
  };
  if (o.position) e.geometry = positionToGeometry(o.position);
  return e;
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
