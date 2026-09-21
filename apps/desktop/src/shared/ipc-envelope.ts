import type { IpcError } from '@worldview/ipc-contract';

/**
 * Wire envelope for `ipcRenderer.invoke` results. Electron flattens rejected
 * promises to a bare Error whose message is all the renderer sees, so the router
 * always resolves with an envelope and the preload turns `ok: false` back into a
 * structured IpcError. Shared between main and preload; imports nothing from Node.
 */
export type IpcResultEnvelope<T = unknown> = { ok: true; value: T } | { ok: false; error: IpcError };

export function okEnvelope<T>(value: T): IpcResultEnvelope<T> {
  return { ok: true, value };
}

export function errorEnvelope(error: IpcError): IpcResultEnvelope<never> {
  return { ok: false, error };
}

export function isEnvelope(v: unknown): v is IpcResultEnvelope {
  return typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean';
}

/** Error class the renderer receives; carries the structured IpcError. */
export class IpcRequestError extends Error implements IpcError {
  readonly code: IpcError['code'];
  readonly channel: string;
  constructor(error: IpcError) {
    super(error.message);
    this.name = 'IpcRequestError';
    this.code = error.code;
    this.channel = error.channel;
  }
}
