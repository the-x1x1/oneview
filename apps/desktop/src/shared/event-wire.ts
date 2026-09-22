import type { EventChannel } from '@worldview/ipc-contract';

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

export interface JsonWirePayload {
  readonly wvJson: string;
}

/** Main process: what to hand `webContents.send` for `event`. Encode once, send to every window. */
export function toWire(event: EventChannel, payload: unknown): unknown {
  return JSON_WIRE_EVENTS.includes(event) ? ({ wvJson: JSON.stringify(payload) } satisfies JsonWirePayload) : payload;
}

export function isJsonWire(payload: unknown): payload is JsonWirePayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { wvJson?: unknown }).wvJson === 'string' &&
    Object.keys(payload).length === 1
  );
}

/** Page: the event as it was emitted. Payloads that were sent as they are pass through. */
export function fromWire<T>(payload: unknown): T {
  return (isJsonWire(payload) ? JSON.parse(payload.wvJson) : payload) as T;
}
