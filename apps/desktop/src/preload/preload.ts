import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CONTRACT_VERSION,
  type EventChannel,
  type RequestChannel,
  type RequestOf,
  type ResponseOf,
  type WorldBridge,
  type WorldEvents,
} from '@worldview/ipc-contract';
import { IpcRequestError } from '../shared/ipc-envelope.js';
import { isPlainPayload, unwrapEnvelope, wireNameFor } from './allowlist.js';

/**
 * Preload — runs in the renderer's isolated world with `sandbox: true`. It exposes
 * exactly one object, `window.worldview` (WorldBridge), and nothing else: no
 * ipcRenderer, no Node globals, no generic `invoke`. Bundled to CommonJS by
 * apps/desktop/scripts/build-main.mjs because sandboxed preloads cannot use ESM.
 */
type AnyListener = (payload: unknown) => void;
const listeners = new Map<EventChannel, Map<AnyListener, (event: IpcRendererEvent, payload: unknown) => void>>();

const bridge: WorldBridge = {
  contractVersion: IPC_CONTRACT_VERSION,
  platform: process.platform,

  async request<C extends RequestChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>> {
    const wire = wireNameFor('request', channel);
    if (!wire)
      throw new IpcRequestError({ code: 'DENIED', message: 'unknown channel', channel: String(channel).slice(0, 80) });
    if (!isPlainPayload(request))
      throw new IpcRequestError({
        code: 'INVALID_REQUEST',
        message: 'request payload must be plain JSON data',
        channel,
      });
    const envelope = await ipcRenderer.invoke(wire, request);
    return unwrapEnvelope<ResponseOf<C>>(channel, envelope);
  },

  on<E extends EventChannel>(event: E, listener: (payload: WorldEvents[E]) => void): () => void {
    const wire = wireNameFor('event', event);
    if (!wire)
      throw new IpcRequestError({ code: 'DENIED', message: 'unknown event', channel: String(event).slice(0, 80) });
    let perEvent = listeners.get(event);
    if (!perEvent) {
      perEvent = new Map();
      listeners.set(event, perEvent);
    }
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => {
      listener(payload as WorldEvents[E]);
    };
    perEvent.set(listener as AnyListener, wrapped);
    ipcRenderer.on(wire, wrapped);
    return () => {
      const w = perEvent!.get(listener as AnyListener);
      if (!w) return;
      perEvent!.delete(listener as AnyListener);
      ipcRenderer.removeListener(wire, w);
    };
  },
};

contextBridge.exposeInMainWorld('worldview', bridge);
