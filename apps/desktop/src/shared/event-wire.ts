import type { EventChannel, RequestChannel } from '@worldview/ipc-contract';

/**
 * How big events travel from the main process to the page.
 *
 * An event object is copied twice on its way to the renderer: Electron's IPC deserialises
 * it into the preload's world, and the context bridge then copies it again, object by
 * object, into the page's. For a satellite refresh — ~5,000 world objects, ~7.8 MB as JSON —
 * that was one 100–130 ms task on the page's main thread every fifteen seconds, all of it
 * spent before the page's own handler ran (the perf log's `deltaReceiveMs`), and it is the
 * hitch a pan across the globe ran into.
 *
 * A string crosses both boundaries as one copy of its bytes. So these events are sent as
 * `{ wvJson }` and parsed in the page, where `JSON.parse` is the only object-building pass
 * left. Only events whose payloads are JSON by construction are listed: world objects are
 * validated plain data (finite numbers, strings, arrays, plain objects), so the round trip
 * through JSON is exact for them.
 */
export const JSON_WIRE_EVENTS: readonly EventChannel[] = ['world.changed'];

/**
 * Responses that carry world objects in bulk, for the same reason. `world.subscribe` answers
 * every zoom out past the regional band with a snapshot of everything the lens shows — 8,151
 * objects when it was measured, half as much again as the refresh above.
 */
export const JSON_WIRE_RESPONSES: readonly RequestChannel[] = ['world.subscribe', 'world.query', 'world.events'];

/**
 * Objects per `world.changed` message. A satellite refresh is one delta of every satellite
 * — 5,000 today, 16,587 if the whole CelesTrak active group is shown — about 1.5 KB of JSON
 * each, and one `JSON.parse` of all of it is one long task however it crossed. Split, each
 * message is a few milliseconds of parsing and the page draws frames in between.
 */
export const WORLD_DELTA_CHUNK = 2_000;

interface WorldDeltaLike {
  added: string[];
  updated: string[];
  removed: string[];
  refreshed: string[];
  objects: Array<{ id: string }>;
  freshness: unknown[];
}

/**
 * One delta as several, each with at most `size` objects. Removals, refreshes and
 * freshness changes ride in the first; `added` and `updated` follow their objects, so a
 * page applying the parts in order ends where it would have applied the whole.
 */
export function chunkWorldDelta<T extends WorldDeltaLike>(delta: T, size: number = WORLD_DELTA_CHUNK): T[] {
  if (delta.objects.length <= size) return [delta];
  const added = new Set(delta.added);
  const parts: T[] = [];
  for (let i = 0; i < delta.objects.length; i += size) {
    const objects = delta.objects.slice(i, i + size);
    const first = i === 0;
    parts.push({
      ...delta,
      objects,
      added: objects.filter((o) => added.has(o.id)).map((o) => o.id),
      updated: objects.filter((o) => !added.has(o.id)).map((o) => o.id),
      removed: first ? delta.removed : [],
      refreshed: first ? delta.refreshed : [],
      freshness: first ? delta.freshness : [],
    });
  }
  return parts;
}

export interface JsonWirePayload {
  readonly wvJson: string;
}

/** Main process: what to hand `webContents.send` for `event`. Encode once, send to every window. */
export function toWire(event: EventChannel, payload: unknown): unknown {
  return JSON_WIRE_EVENTS.includes(event) ? ({ wvJson: JSON.stringify(payload) } satisfies JsonWirePayload) : payload;
}

/** Main process: the value to put in the response envelope for `channel`. */
export function responseToWire(channel: RequestChannel, value: unknown): unknown {
  return JSON_WIRE_RESPONSES.includes(channel) && value !== undefined
    ? ({ wvJson: JSON.stringify(value) } satisfies JsonWirePayload)
    : value;
}

export function isJsonWire(payload: unknown): payload is JsonWirePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { wvJson?: unknown }).wvJson === 'string' &&
    Object.keys(payload).length === 1
  );
}

/** Page: the event or response as it was produced. Anything sent as it was passes through. */
export function fromWire<T>(payload: unknown): T {
  return (isJsonWire(payload) ? JSON.parse(payload.wvJson) : payload) as T;
}
