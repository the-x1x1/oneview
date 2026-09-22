import { boundsContain, type GeoBounds, type WorldObject } from '@worldview/world-model';
import type { WorldChangedEvent, WorldSubscription } from '@worldview/ipc-contract';
import type { StateChange } from '@worldview/state-engine';

/**
 * Per-client `world.subscribe` filters. A client only ever receives objects that match
 * its own subscription, so a window showing Hawaii is not fed every aircraft on earth;
 * pinned ids are always included regardless of bounds and type.
 */
export interface ClientSubscription extends WorldSubscription {
  clientId: string;
}

export class SubscriptionRegistry {
  private readonly subscriptions = new Map<string, ClientSubscription>();

  set(clientId: string, subscription: WorldSubscription): ClientSubscription {
    const entry: ClientSubscription = { clientId, ...subscription };
    this.subscriptions.set(clientId, entry);
    return entry;
  }

  get(clientId: string): ClientSubscription | undefined {
    return this.subscriptions.get(clientId);
  }
  remove(clientId: string): void {
    this.subscriptions.delete(clientId);
  }
  all(): ClientSubscription[] {
    return [...this.subscriptions.values()];
  }
  get size(): number {
    return this.subscriptions.size;
  }
}

export function matchesSubscription(object: WorldObject, subscription: WorldSubscription): boolean {
  if (subscription.pinnedIds?.includes(object.id)) return true;
  if (
    subscription.objectTypes &&
    subscription.objectTypes.length > 0 &&
    !subscription.objectTypes.includes(object.type)
  )
    return false;
  if (subscription.bounds) {
    if (!object.position) return false;
    if (!boundsContain(subscription.bounds, object.position)) return false;
  }
  return true;
}

export function filterObjects(
  objects: Iterable<WorldObject>,
  subscription: WorldSubscription,
  limit?: number,
): WorldObject[] {
  const out: WorldObject[] = [];
  for (const o of objects) {
    if (!matchesSubscription(o, subscription)) continue;
    out.push(o);
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
}

/**
 * Build the delta this client should see. `removed` carries every id the client may be
 * holding (an object that moved out of bounds is a removal for that client), while
 * `added`/`updated` only carry ids whose object currently matches.
 */
export function deltaFor(
  change: StateChange,
  subscription: WorldSubscription,
  lookup: (id: string) => WorldObject | undefined,
): WorldChangedEvent | undefined {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [...change.removed];
  const objects: WorldObject[] = [];

  for (const id of change.added) {
    const o = lookup(id);
    if (o && matchesSubscription(o, subscription)) {
      added.push(id);
      objects.push(o);
    }
  }
  for (const id of change.updated) {
    const o = lookup(id);
    if (!o) {
      removed.push(id);
      continue;
    }
    if (matchesSubscription(o, subscription)) {
      updated.push(id);
      objects.push(o);
    } else removed.push(id);
  }

  const freshness: WorldChangedEvent['freshness'] = [];
  const refreshed: string[] = [];
  for (const id of change.refreshed) {
    const o = lookup(id);
    if (!o || !matchesSubscription(o, subscription)) continue;
    refreshed.push(id);
    freshness.push({ id, freshness: o.freshness });
  }

  if (added.length + updated.length + removed.length + refreshed.length === 0) return undefined;
  return { added, updated, removed, refreshed, at: change.at, objectCount: change.objectCount, objects, freshness };
}

/** Diff two object sets by id — the timeline projection's equivalent of a StateChange. */
export function diffObjectSets(
  previous: Map<string, WorldObject>,
  next: Map<string, WorldObject>,
  at: string,
): StateChange {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const [id, object] of next) {
    const before = previous.get(id);
    if (!before) added.push(id);
    else if (before.observedAt !== object.observedAt || before.updatedAt !== object.updatedAt) updated.push(id);
  }
  for (const id of previous.keys()) if (!next.has(id)) removed.push(id);
  return { added, updated, removed, refreshed: [], at, objectCount: next.size };
}

export function boundsOfSubscriptions(subscriptions: readonly WorldSubscription[]): GeoBounds | undefined {
  let out: GeoBounds | undefined;
  for (const s of subscriptions) {
    if (!s.bounds) return undefined; // one unbounded client means everything is needed
    out = out
      ? {
          west: Math.min(out.west, s.bounds.west),
          south: Math.min(out.south, s.bounds.south),
          east: Math.max(out.east, s.bounds.east),
          north: Math.max(out.north, s.bounds.north),
        }
      : { ...s.bounds };
  }
  return out;
}
