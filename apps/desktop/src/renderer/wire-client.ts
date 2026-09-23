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
 * The preload's bridge as the shell's client, with events and responses sent as JSON
 * (shared/event-wire.ts) parsed back here, in the page's own world — parsing in the preload would hand the context
 * bridge the object graph to copy all over again. How long each parse took goes to the perf
 * log (`deltaParseMs`).
 */
export function wireClient(
  bridge: WorldBridge,
  now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): WorldClient {
  const decode = <T>(payload: unknown): T => {
    if (!isJsonWire(payload)) return payload as T;
    const startedAt = now();
    const decoded = fromWire<T>(payload);
    noteDecode(now() - startedAt);
    return decoded;
  };
  return {
    contractVersion: bridge.contractVersion,
    async request<C extends RequestChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>> {
      const response: unknown = await bridge.request(channel, request);
      return decode<ResponseOf<C>>(response);
    },
    on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E]) => void): () => void {
      return bridge.on(event, (payload: unknown) => listener(decode<WorldEvents[E]>(payload)));
    },
  };
}
