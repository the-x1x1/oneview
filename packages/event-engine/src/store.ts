import {
  stableStringify,
  type JsonValue,
  type WorldEvent,
  type WorldQuery,
  type WorldQueryResult,
} from '@worldview/world-model';
import { executeEventQuery, type EventSource } from '@worldview/query-engine';

/**
 * EventStore — in-memory, bounded, deterministic. Events are indexed by id and type
 * and kept in startAt-descending order (id tie-break). When the bound is exceeded the
 * oldest events by startAt are evicted.
 *
 * `upsert` reports whether anything changed; two events that differ only in
 * `provenance.receivedAt` are considered unchanged so re-evaluation does not churn.
 */
export type UpsertOutcome = 'added' | 'updated' | 'unchanged';

export interface EventStoreOptions {
  /** Maximum events kept (default 20 000). */
  maxEvents?: number;
}

export class EventStore implements EventSource {
  private readonly byId = new Map<string, WorldEvent>();
  private readonly byType = new Map<string, Set<string>>();
  private readonly byObject = new Map<string, Set<string>>();
  private ordered: WorldEvent[] = [];
  private readonly maxEvents: number;

  constructor(opts: EventStoreOptions = {}) {
    this.maxEvents = Math.max(1, opts.maxEvents ?? 20_000);
  }

  get size(): number {
    return this.byId.size;
  }
  get(id: string): WorldEvent | undefined {
    return this.byId.get(id);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Newest first (startAt desc, id asc). */
  all(): readonly WorldEvent[] {
    return this.ordered;
  }

  ofType(type: string): WorldEvent[] {
    const ids = this.byType.get(type);
    if (!ids) return [];
    return this.ordered.filter((e) => ids.has(e.id));
  }

  forObject(objectId: string): WorldEvent[] {
    const ids = this.byObject.get(objectId);
    if (!ids) return [];
    return this.ordered.filter((e) => ids.has(e.id));
  }

  upsert(event: WorldEvent): UpsertOutcome {
    const prev = this.byId.get(event.id);
    if (prev) {
      if (fingerprint(prev) === fingerprint(event)) return 'unchanged';
      this.unlink(prev);
    }
    this.link(event);
    this.evict();
    return prev ? 'updated' : 'added';
  }

  remove(id: string): boolean {
    const prev = this.byId.get(id);
    if (!prev) return false;
    this.unlink(prev);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.byType.clear();
    this.byObject.clear();
    this.ordered = [];
  }

  /** Query with the shared deterministic executor (eventTypes, region, time overlap, filters, text, sort, limit). */
  list(query: WorldQuery, now: number): WorldQueryResult<WorldEvent> {
    return executeEventQuery(query, { events: this, now: () => now });
  }

  /**
   * Related events: for an object, every event that references it; for an event,
   * events sharing an object plus explicit links (mainshockEventId, mergedInto) in both directions.
   */
  related(ref: { objectId?: string; eventId?: string }): WorldEvent[] {
    const out = new Map<string, WorldEvent>();
    if (ref.objectId) for (const e of this.forObject(ref.objectId)) out.set(e.id, e);
    if (ref.eventId) {
      const e = this.byId.get(ref.eventId);
      if (e) {
        for (const oid of e.objectIds)
          for (const other of this.forObject(oid)) if (other.id !== e.id) out.set(other.id, other);
        for (const key of ['mainshockEventId', 'mergedInto'] as const) {
          const target = e.properties?.[key];
          if (typeof target === 'string') {
            const t = this.byId.get(target);
            if (t) out.set(t.id, t);
          }
        }
        for (const other of this.ordered) {
          if (other.id === e.id) continue;
          if (other.properties?.['mainshockEventId'] === e.id || other.properties?.['mergedInto'] === e.id)
            out.set(other.id, other);
        }
      }
    }
    return [...out.values()].sort(compareEvents);
  }

  private link(event: WorldEvent): void {
    this.byId.set(event.id, event);
    index(this.byType, event.type, event.id);
    for (const oid of event.objectIds) index(this.byObject, oid, event.id);
    const at = insertionIndex(this.ordered, event);
    this.ordered.splice(at, 0, event);
  }

  private unlink(event: WorldEvent): void {
    this.byId.delete(event.id);
    this.byType.get(event.type)?.delete(event.id);
    for (const oid of event.objectIds) this.byObject.get(oid)?.delete(event.id);
    const i = this.ordered.findIndex((e) => e.id === event.id);
    if (i >= 0) this.ordered.splice(i, 1);
  }

  private evict(): void {
    while (this.ordered.length > this.maxEvents) {
      const oldest = this.ordered[this.ordered.length - 1]!;
      this.unlink(oldest);
    }
  }
}

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

export function compareEvents(a: WorldEvent, b: WorldEvent): number {
  const ta = Date.parse(a.startAt),
    tb = Date.parse(b.startAt);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function insertionIndex(list: WorldEvent[], e: WorldEvent): number {
  let lo = 0,
    hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEvents(list[mid]!, e) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Stable content fingerprint ignoring provenance.receivedAt. */
export function fingerprint(e: WorldEvent): string {
  const { provenance, ...rest } = e;
  const prov: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(provenance)) if (k !== 'receivedAt' && v !== undefined) prov[k] = v as JsonValue;
  return stableStringify({ ...rest, provenance: prov } as unknown as JsonValue);
}
