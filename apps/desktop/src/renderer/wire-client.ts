import type {
  EventChannel,
  RequestChannel,
  RequestOf,
  ResponseOf,
  WorldBridge,
  WorldClient,
  WorldEvents,
} from '@worldview/ipc-contract';
import { fromWire, isJsonWire } from '../shared/event-wire.js';
import { noteDecode } from './map/delta-marks.js';

/**
 * The preload's bridge as the shell's client, with events sent as JSON (shared/event-wire.ts)
 * parsed back here, in the page's own world — parsing in the preload would hand the context
 * bridge the object graph to copy all over again. How long each parse took goes to the perf
 * log (`deltaParseMs`).
 */
export function wireClient(
  bridge: WorldBridge,
  now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): WorldClient {
  return {
    contractVersion: bridge.contractVersion,
    request<C extends RequestChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>> {
      return bridge.request(channel, request);
    },
    on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E]) => void): () => void {
      return bridge.on(event, (payload: unknown) => {
        if (!isJsonWire(payload)) {
          listener(payload as WorldEvents[E]);
          return;
        }
        const startedAt = now();
        const decoded = fromWire<WorldEvents[E]>(payload);
        noteDecode(now() - startedAt);
        listener(decoded);
      });
    },
  };
}
