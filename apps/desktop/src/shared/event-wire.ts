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
 * Limits for one `world.changed` message. A satellite refresh is one delta of every
 * satellite — about 1.5 KB of JSON each — and one `JSON.parse` of all of it is one long task
 * however it crossed; entering replay was worse, 107 ms for one part of 2,000 objects,
 * because weather alerts recorded before outlines were simplified carry tens of kilobytes
 * of polygon each. So a delta is split by size as well as by count, and each part is a few
 * milliseconds of parsing, with frames drawn in between.
 */
export const WORLD_DELTA_CHUNK = 2_000;
export const WORLD_DELTA_MAX_BYTES = 1_000_000;

interface WorldDeltaLike {
  added: string[];
  updated: string[];
  removed: string[];
  refreshed: string[];
  objects: Array<{ id: string }>;
  freshness: unknown[];
}

/**
 * One delta as several, each with at most `maxObjects` objects and about `maxBytes` of
 * JSON (an object larger than that travels alone). Removals, refreshes and freshness
 * changes ride in the first; `added` and `updated` follow their objects, so a page applying
 * the parts in order ends where it would have applied the whole. Each part is returned
 * already encoded, every object stringified exactly once.
 */
export function worldDeltaWireParts<T extends WorldDeltaLike>(
  delta: T,
  opts: { maxObjects?: number; maxBytes?: number } = {},
): JsonWirePayload[] {
  const maxObjects = opts.maxObjects ?? WORLD_DELTA_CHUNK;
  const maxBytes = opts.maxBytes ?? WORLD_DELTA_MAX_BYTES;
  const encoded = delta.objects.map((o) => JSON.stringify(o));
  const total = encoded.reduce((n, e) => n + e.length, 0);
  if (delta.objects.length <= maxObjects && total <= maxBytes) return [{ wvJson: JSON.stringify(delta) }];
  const added = new Set(delta.added);
  const { objects: _objects, added: _added, updated: _updated, removed, refreshed, freshness, ...rest } = delta;
  const parts: JsonWirePayload[] = [];
  let first = true;
  let i = 0;
  while (i < encoded.length || first) {
    const ids: string[] = [];
    const body: string[] = [];
    let bytes = 0;
    while (
      i < encoded.length &&
      ids.length < maxObjects &&
      (ids.length === 0 || bytes + encoded[i]!.length <= maxBytes)
    ) {
      ids.push(delta.objects[i]!.id);
      body.push(encoded[i]!);
      bytes += encoded[i]!.length;
      i++;
    }
    const head = {
      ...rest,
      added: ids.filter((id) => added.has(id)),
      updated: ids.filter((id) => !added.has(id)),
      removed: first ? removed : [],
      refreshed: first ? refreshed : [],
      freshness: first ? freshness : [],
    };
    // `{...head, "objects":[...]}` without re-encoding the objects.
    const headJson = JSON.stringify(head);
    parts.push({ wvJson: `${headJson.slice(0, -1)}${headJson.length > 2 ? ',' : ''}"objects":[${body.join(',')}]}` });
    first = false;
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
